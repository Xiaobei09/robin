import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { StructuredReview, ReviewFinding } from "./review-parser";

/** Marker present in every Robin review body; used to recognize Robin's own reviews. */
export const ROBIN_SIGNATURE = ":bow_and_arrow: Robin";

/**
 * The single invisible marker identifying *the* Robin comment on a PR.
 *
 * **为什么只有一个 marker。** 之前 Robin 有两个身份标记：`ROBIN_SIGNATURE`
 * （`:bow_and_arrow: Robin`，靠文本匹配，只能用于 review 对象）和
 * `<!-- robin:status -->`（只盖状态评论）。工作流失败自动重启之后，状态评论
 * 走「认领上一条」，于是 PR 上会留下一条 `<!-- robin:status -->` 的状态评论，
 * 外加每次重启各自新发的内容 —— 读者看到的是「同一个人在说话，但说了好几遍」。
 *
 * 现在两类评论共用 `REVIEW_MARKER`，查找条件是「作者是 `github-actions[bot]`
 * 且正文含 marker」，find-then-create-or-update 之后**至多一条**：重启只 PATCH，
 * 绝不 POST 第二条。
 */
export const REVIEW_MARKER = "<!-- robin-ai-review -->";

/** The login GitHub Actions commits comment as; half of the identity check. */
export const ROBIN_BOT_LOGIN = "github-actions[bot]";

/** A Robin-owned issue comment that a later run may adopt instead of creating a new one. */
export interface RobinComment {
  id: number;
  body: string;
}

/**
 * Put the marker at the very start of a body, exactly once.
 *
 * **为什么放开头而不是结尾。** marker 必须在首行，否则 GitHub 在渲染成 HTML 后
 * 会把它跟正文之间插入一个 `<p>`，用 `startsWith` 认领就会失配。
 *
 * 幂等：已经以 marker 开头（含前后空白）的正文原样返回，所以重试同一段文本
 * 不会累积出 `<!-- robin-ai-review --><!-- robin-ai-review -->`。
 */
export function decorateRobinCommentBody(body: string): string {
  const text = typeof body === "string" ? body : "";
  return text.trimStart().startsWith(REVIEW_MARKER) ? text : REVIEW_MARKER + "\n" + text;
}

/** The narrow slice of octokit the comment helpers touch. */
type RobinCommentClient = {
  paginate?: (
    route: unknown,
    params: { owner: string; repo: string; issue_number: number; per_page: number }
  ) => Promise<unknown>;
  rest?: {
    issues?: {
      listComments?: unknown;
      createComment?: unknown;
      updateComment?: unknown;
      deleteComment?: unknown;
    };
  };
};

/**
 * The newest Robin comment on the issue, or undefined when there is none.
 *
 * Paginated with `per_page=100` and walked end-to-start so the *most recent*
 * marked comment wins: a PR with >100 comments (very common once humans pile in)
 * must still find its marker on a later page instead of silently concluding
 * "no comment yet" and posting a second one.
 *
 * Best-effort, like every other listing here: any API failure returns undefined so
 * the caller falls back to creating a comment rather than failing the run.
 */
export async function findExistingReviewComment(
  octokit: unknown,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<RobinComment | undefined> {
  const client = octokit as RobinCommentClient;
  const paginate = client?.paginate;
  const listComments = client?.rest?.issues?.listComments;
  if (typeof paginate !== "function" || !listComments) return undefined;
  try {
    const comments = await paginate.call(octokit, listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    if (!Array.isArray(comments)) return undefined;
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i] as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
      const id = Number(comment?.id);
      if (!Number.isFinite(id)) continue;
      // Both halves matter: a human who quoted the marker (or a bot relaying one)
      // must never be adopted — overwriting a human's words is unrecoverable.
      if (comment?.user?.login !== ROBIN_BOT_LOGIN) continue;
      if (typeof comment?.body !== "string" || !comment.body.includes(REVIEW_MARKER)) continue;
      return { id, body: comment.body as string };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adopt Robin's existing comment if there is one, otherwise create it.
 *
 * This is the whole restart story in one function: run 2 PATCHes run 1's comment
 * instead of POSTing a sibling, so three runs leave exactly one comment on the PR.
 * Returns the comment id so the caller can keep updating it for the rest of the run.
 */
export async function publishRobinComment(
  octokit: unknown,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<number | undefined> {
  const client = octokit as RobinCommentClient;
  const decorated = decorateRobinCommentBody(body);
  const existing = await findExistingReviewComment(octokit, owner, repo, issueNumber);

  if (existing) {
    try {
      const update = client?.rest?.issues?.updateComment;
      if (typeof update === "function") {
        await (update as Function).call(octokit, {
          owner,
          repo,
          comment_id: existing.id,
          body: decorated,
        });
        return existing.id;
      }
    } catch (error) {
      // A stale/deleted comment id must not sink the run: fall through and re-create.
      core.warning("Could not update Robin comment #" + existing.id + ", recreating: " + error);
    }
  }

  try {
    const create = client?.rest?.issues?.createComment;
    if (typeof create !== "function") return undefined;
    const response = (await (create as Function).call(octokit, {
      owner,
      repo,
      issue_number: issueNumber,
      body: decorated,
    })) as { data?: { id?: unknown } };
    const id = Number(response?.data?.id);
    return Number.isFinite(id) ? id : undefined;
  } catch (error) {
    core.warning("Could not post Robin comment: " + error);
    return undefined;
  }
}

/**
 * Delete Robin's *other* marked comments, keeping `keepId`.
 *
 * **判据必须同时满足三条：带 marker + 作者是 bot + 不是 `keepId`。**
 *
 * 为什么 marker 这条不能少（R1077）：只判作者会删掉 PR 上**任何**其它
 * `github-actions[bot]` 评论，包括跟 Robin 毫无关系的 —— 消费仓里任何一个用默认
 * token 调 `createComment` 的工具（覆盖率机器人、stale 清理、辅助脚本）发的东西，
 * 都会在每次 review 开始时被静默删掉，且不可恢复。而函数名承诺的是「删除上一轮的
 * **review** 评论」，实现比承诺宽。
 *
 * 之前只判作者，是因为这个函数和 marker 判据是同一次改动（R1067）里加进来的，
 * 而 marker 只被用在了查找路径上。R1068 给 status 的 legacy 回退补了作者校验，
 * 却没人回头看清理路径 —— 「只补了一半」比「漏了」更难发现，因为两处都存在。
 *
 * marker 判据复用 `findExistingReviewComment` 的同一份（`includes(REVIEW_MARKER)`），
 * 不另写一份：两处一旦分叉，就会出现「找得到但删不掉」或反之的诡异状态。
 *
 * 单条删除失败只记日志并跳过 —— 清理问题永远不该让一次 review 失败。
 */
export async function deletePreviousReviewComments(
  octokit: unknown,
  owner: string,
  repo: string,
  issueNumber: number,
  keepId: number | undefined
): Promise<number> {
  const client = octokit as RobinCommentClient;
  const paginate = client?.paginate;
  const listComments = client?.rest?.issues?.listComments;
  const deleteComment = client?.rest?.issues?.deleteComment;
  if (typeof paginate !== "function" || !listComments || typeof deleteComment !== "function") return 0;

  try {
    const comments = (await paginate.call(octokit, listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    })) as Array<{ id?: unknown; body?: unknown; user?: { login?: unknown } | null }>;
    if (!Array.isArray(comments)) return 0;

    let deleted = 0;
    for (const comment of comments) {
      const id = Number(comment?.id);
      if (!Number.isFinite(id) || id === keepId) continue;
      if (comment?.user?.login !== ROBIN_BOT_LOGIN) continue;
      if (typeof comment?.body !== "string" || !comment.body.includes(REVIEW_MARKER)) continue;
      try {
        await (deleteComment as Function).call(octokit, {
          owner,
          repo,
          comment_id: id,
        });
        deleted++;
      } catch (error) {
        core.warning("Could not delete duplicate Robin comment #" + id + ": " + error);
      }
    }
    return deleted;
  } catch (error) {
    core.warning("Could not list Robin comments for cleanup: " + error);
    return 0;
  }
}

export class GitHubReviewer {
  private octokit: Octokit;
  private maxComments: number;

  constructor(octokit: Octokit, maxComments = 25) {
    this.octokit = octokit;
    this.maxComments = Number.isFinite(maxComments) ? Math.max(0, maxComments) : 25;
  }

  /** COMMENT unless a High finding exists AND request-changes is enabled (gatekeeper mode). */
  static resolveReviewEvent(hasHigh: boolean, requestChanges: boolean): "REQUEST_CHANGES" | "COMMENT" {
    return hasHigh && requestChanges ? "REQUEST_CHANGES" : "COMMENT";
  }

  /** A prior Robin CHANGES_REQUESTED review that a newly posted review supersedes. */
  static isStaleRobinReview(
    review: { id: number; state?: string; body?: string | null; user?: { type?: string } | null },
    newReviewId: number
  ): boolean {
    return (
      review.id !== newReviewId &&
      review.state === "CHANGES_REQUESTED" &&
      review.user?.type === "Bot" &&
      (review.body || "").includes(ROBIN_SIGNATURE)
    );
  }

  /**
   * Dismiss earlier Robin CHANGES_REQUESTED reviews so a stale blocking review
   * from a previous (possibly cancelled) run doesn't keep gating the PR.
   */
  private async dismissStaleRobinReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    newReviewId: number
  ): Promise<void> {
    try {
      const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });

      for (const review of reviews) {
        if (!GitHubReviewer.isStaleRobinReview(review, newReviewId)) continue;
        try {
          await this.octokit.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: pullNumber,
            review_id: review.id,
            message: "Superseded by a newer Robin review.",
          });
          core.info("Dismissed stale Robin review #" + review.id);
        } catch (error) {
          core.warning("Could not dismiss stale Robin review #" + review.id + ": " + error);
        }
      }
    } catch (error) {
      core.warning("Could not check for stale Robin reviews: " + error);
    }
  }

  async postReview(
    owner: string,
    repo: string,
    pullNumber: number,
    findings: StructuredReview,
    requestChanges = true
  ): Promise<void> {
    try {
      core.info("Posting review to PR #" + pullNumber + "...");

      // Fetch file patches to map line positions
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });

      // Build line-level comments from findings
      const { comments, postedFindings } = this.buildReviewComments(findings, files);

      // Build the review summary body (high-level)
      const body = this.buildReviewBody(findings, postedFindings);
      
      // Determine review event type
      const event = GitHubReviewer.resolveReviewEvent(findings.high.length > 0, requestChanges);
      
      let review;
      let postedInlineComments = comments.length;
      try {
        const response = await this.octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body,
          event,
          comments,
        });
        review = response.data;
      } catch (error) {
        if (!this.shouldRetryWithoutInlineComments(error) || comments.length === 0) {
          throw error;
        }

        core.warning(
          "GitHub rejected one or more inline comments; posting summary review without inline comments."
        );
        const response = await this.octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          // The failed review is not created, so include every finding in the fallback body.
          body: this.buildReviewBody(findings, new Set()),
          event,
        });
        review = response.data;
        postedInlineComments = 0;
      }

      core.info(
        "Posted review #" + review.id + " with " + postedInlineComments + " individual line comments"
      );

      await this.dismissStaleRobinReviews(owner, repo, pullNumber, review.id);

    } catch (error) {
      core.error("Failed to post review: " + error);
      throw error;
    }
  }

  /**
   * Build separate line-level comments for each finding that can be mapped to a line.
   * Each comment appears as an individual thread the repo owner can reply to and resolve.
   */
  private buildReviewComments(
    findings: StructuredReview,
    files: any[]
  ): { comments: any[]; postedFindings: Set<ReviewFinding> } {
    const comments: any[] = [];
    const postedFindings = new Set<ReviewFinding>();

    // Combine all findings
    const allFindings = [
      ...findings.high,
      ...findings.medium,
      ...findings.low,
      ...findings.suggestions,
    ];

    for (const finding of allFindings) {
      if (comments.length >= this.maxComments) {
        core.info(`Reached max-comments limit (${this.maxComments}); remaining findings will stay in the review body.`);
        break;
      }

      // Need both file and line to post a line comment
      if (!finding.file || !finding.line) continue;

      const diffFile = files.find((f: any) => f.filename === finding.file);
      if (!diffFile) {
        core.warning("Could not find diff for file: " + finding.file);
        continue;
      }

      if (!this.isLineInNewDiff(diffFile.patch || "", finding.line)) {
        core.warning(
          "Could not find line " + finding.line + " in diff for file: " + finding.file
        );
        continue;
      }

      const commentBody = this.formatCommentBody(finding);

      comments.push({
        path: finding.file,
        line: finding.line,
        side: "RIGHT",
        body: commentBody,
      });
      postedFindings.add(finding);
    }

    return { comments, postedFindings };
  }

  private formatCommentBody(finding: ReviewFinding): string {
    const severityEmoji =
      finding.severity === "high"
        ? ":rotating_light: HIGH"
        : finding.severity === "medium"
        ? ":warning: MEDIUM"
        : finding.severity === "low"
        ? ":large_blue_circle: LOW"
        : ":bulb: SUGGESTION";

    const confidence = finding.confidence ? " · confidence: " + finding.confidence : "";
    let body = "**Robin** — " + severityEmoji + confidence + "\n\n" + finding.description;

    if (finding.recommendation) {
      body += "\n\n**Recommendation:** " + finding.recommendation;
    }

    if (finding.codeSnippet) {
      body += "\n\n```\n" + finding.codeSnippet + "\n```";
    }

    return body;
  }

  private shouldRetryWithoutInlineComments(error: unknown): boolean {
    const candidate = error as {
      status?: number;
      message?: string;
      response?: {
        data?: {
          message?: string;
          errors?: Array<{ message?: string; code?: string; field?: string }>;
        };
      };
    };

    if (candidate.status !== 422) return false;

    const details = [
      candidate.message,
      candidate.response?.data?.message,
      ...(candidate.response?.data?.errors || []).flatMap((item) => [
        item.message,
        item.code,
        item.field,
      ]),
    ].filter(Boolean).join(" ");

    return /position|line|side|diff/i.test(details);
  }

  /**
   * Build a concise summary body. Findings are shown here ONLY if they
   * could not be mapped to individual line comments.
   */
  private buildReviewBody(findings: StructuredReview, postedFindings: Set<ReviewFinding>): string {
    const parts: string[] = [];

    parts.push("## " + ROBIN_SIGNATURE);
    parts.push("");
    parts.push(
      "> **Heads up:** this is a point-in-time review. Push fixes freely, then comment `/robin` whenever you want another pass."
    );
    parts.push("");

    // Stats summary
    const statBlocks: string[] = [];
    if (findings.high.length > 0) {
      statBlocks.push(":rotating_light: **" + findings.high.length + " High**");
    }
    if (findings.medium.length > 0) {
      statBlocks.push(":warning: **" + findings.medium.length + " Medium**");
    }
    if (findings.low.length > 0) {
      statBlocks.push(":large_blue_circle: **" + findings.low.length + " Low**");
    }
    if (findings.suggestions.length > 0) {
      statBlocks.push(":bulb: **" + findings.suggestions.length + " Suggestions**");
    }
    if (statBlocks.length === 0) {
      statBlocks.push(":white_check_mark: **No issues found**");
    }
    parts.push(statBlocks.join(" | "));

    // Overall summary from the model
    if (findings.summary) {
      parts.push("");
      parts.push("### Summary");
      parts.push(findings.summary);
    }

    // Add findings that were not posted inline because they had no line, mapping failed,
    // or the max-comments limit was reached.
    const unpostedFindings = [
      ...findings.high,
      ...findings.medium,
      ...findings.low,
      ...findings.suggestions,
    ].filter((f) => !postedFindings.has(f));

    if (unpostedFindings.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("### :page_facing_up: Findings Not Posted Inline");
      for (let i = 0; i < unpostedFindings.length; i++) {
        parts.push("");
        parts.push(this.formatUnpostedFinding(i + 1, unpostedFindings[i]));
      }
    }

    parts.push("");
    parts.push("---");
    parts.push(
      "*[Robin](https://robinreview.dev) — the Robin Hood of code review. Free for every PR.*"
    );

    return parts.join("\n");
  }

  private formatUnpostedFinding(index: number, finding: ReviewFinding): string {
    const line = finding.line ? ":" + finding.line : "";
    const location = finding.file ? " (`" + finding.file + line + "`)" : "";
    let result =
      finding.severity === "high"
        ? ":rotating_light:"
        : finding.severity === "medium"
        ? ":warning:"
        : finding.severity === "low"
        ? ":large_blue_circle:"
        : ":bulb:";
    result += " **" + index + location + "** — " + finding.description;

    if (finding.recommendation) {
      result += "\n> " + finding.recommendation;
    }
    return result;
  }

  /**
   * Check whether a new-file line number is present in the diff.
   * GitHub only accepts review comments on lines included in the PR diff.
   */
  private isLineInNewDiff(patch: string, targetLine: number): boolean {
    if (!patch) return false;

    let currentLine = 0;
    let inHunk = false;

    for (const line of patch.split("\n")) {
      // Hunk header: parse the starting line number in the NEW file
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          // +N is the first line of this hunk in the new file
          currentLine = parseInt(match[1], 10);
        }
        inHunk = true;
        continue;
      }

      if (!inHunk) {
        // Lines before the first hunk (shouldn't happen in patch)
        continue;
      }

      if (line.startsWith("\\")) {
        continue;
      }

      if (line.startsWith("+")) {
        // Added line exists in the new file
        if (currentLine === targetLine) {
          return true;
        }
        currentLine++;
      } else if (line.startsWith("-")) {
        // Removed line — does not exist in new file, keep position but don't count line
      } else {
        // Context line — exists in both old and new file
        if (currentLine === targetLine) {
          return true;
        }
        currentLine++;
      }
    }

    return false;
  }
}
