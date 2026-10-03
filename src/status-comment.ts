/**
 * Helpers for Robin's PR status comment.
 *
 * Two problems are solved here.
 *
 * 1. Comment pile-up. Every run used to `createComment` a fresh status comment, so a PR
 *    that was reviewed five times carried five "On it" comments and the newest one could
 *    scroll out of view, leaving the reader unsure whether the bot was still working.
 *    Status comments now carry an invisible marker and a new run *adopts* the most recent
 *    marked comment instead of creating another one.
 *
 * 2. Lost verdicts. Adopting a comment means overwriting the previous run's status, so the
 *    previous verdict would disappear from the PR the moment a retry started. Every status
 *    body therefore keeps a human-readable "Last result:" line, and the next run carries it
 *    forward. The line is scanned from the *end* so that a third run still finds the
 *    original verdict rather than re-inheriting its own copy.
 */

import * as core from "@actions/core";
import type { ReviewerCommand } from "./commands";
import {
  ROBIN_BOT_LOGIN,
  ROBIN_SIGNATURE,
  REVIEW_MARKER,
  decorateRobinCommentBody,
  deletePreviousReviewComments,
  findExistingReviewComment,
  publishRobinComment,
} from "./github-reviewer";

/**
 * Invisible marker that identifies the one Robin comment on an issue.
 *
 * **现在等于 `REVIEW_MARKER`。** 曾经它是另一个字符串 `<!-- robin:status -->`，
 * 于是状态评论和 review 各用各的标记，工作流失败重启后 PR 上会出现两条
 * 「都是 Robin 的」评论。统一之后 find-then-create-or-update 只认一个身份，
 * 三次运行也只留一条。
 *
 * 老名字保留是为了兼容：它现在是同一个值，`findLatestStatusComment` 也仍会
 * 认领正文里带旧标记的历史评论，升级不会让存量 PR 突然多出一条。
 */
export const STATUS_COMMENT_MARKER = REVIEW_MARKER;

/** Legacy marker written by older Robin versions; still adopted so upgrades don't double-post. */
const LEGACY_STATUS_COMMENT_MARKER = "<!-- robin:status -->";


/**
 * 失败状态评论的正文。
 *
 * **为什么从 `main.ts` 搬出来。** 它原来在 `main.ts` 里是模块私有函数，而
 * `main.ts` 一被 import 就整个 `run()` 起来，所以这类函数永远拿不到测试 ——
 * 于是只能测旁边那个「长得像」的 helper。R941 的教训正出在这里：生产上
 * `Reason:` 是空的，那一轮的修复却打在了一个**这条路径根本没调用**的
 * `errorMessage` 上，8 条断言 3 个变异全绿，线上 bug 原封不动。
 *
 * **为什么在渲染点还兜一次底。** 上游 `errorMessage()` 已经对空 message 兜底，
 * 这里再兜一次是刻意的冗余：空 Reason 恰恰出现在最需要解释的那次失败上，
 * 而「多写一个常量」的成本是零。将来新增调用点忘了上游兜底，也不会退化回
 * 生产上那条什么都不说的评论。
 */
export function buildFailedStatusBody(
  reason: string,
  command: "review" | "summary"
): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:warning: I couldn't finish the ${command === "summary" ? "summary" : "review"} this time.`,
    "",
    `Reason: ${text || "unknown error (no message)"}`,
    "",
    "Free model routes drop sometimes — comment `/robin` to try again. (No secrets are included in this message.)",
  ].join("\n");
}

/** Prefix of the line that carries the previous run's verdict forward. */
export const LAST_RESULT_PREFIX = "> **Last result:** ";

/** Prefix the marker to a status body. Idempotent; delegates to the shared marker helper. */
export function decorateStatusCommentBody(body: string): string {
  return decorateRobinCommentBody(body);
}

/**
 * The most recent inherited verdict recorded in a status body, or undefined.
 *
 * Scans for the *last* occurrence: once run 2 has inherited run 1's verdict the body holds
 * two lines, and re-inheriting run 2's own copy would keep the value stable across runs.
 */
export function extractInheritedVerdict(body: string | null | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(LAST_RESULT_PREFIX) && line.length > LAST_RESULT_PREFIX.length) {
      return line.slice(LAST_RESULT_PREFIX.length).trim();
    }
  }
  return undefined;
}

/** The "On it" status body posted at the start of a run, optionally carrying a prior verdict. */
export function buildInitialStatusBody(
  command: "review" | "summary",
  model: string,
  inheritedVerdict?: string
): string {
  return [
    "## :bow_and_arrow: Robin",
    "",
    ":eyes: On it — taking a look at this pull request.",
    "",
    ...(inheritedVerdict ? [`${LAST_RESULT_PREFIX}${inheritedVerdict}`, ""] : []),
    `Mode: ${command === "summary" ? "summary" : "code review"}`,
    `Model: ${model}`,
  ].join("\n");
}

/** A status comment that a later run may adopt. */
export interface AdoptableStatusComment {
  id: number;
  body: string;
}

type StatusCommentLister = {
  paginate: (
    route: unknown,
    params: { owner: string; repo: string; issue_number: number; per_page: number }
  ) => Promise<Array<{ id?: unknown; body?: unknown }>>;
};

/**
 * The newest marked status comment on the issue, or undefined when there is none.
 *
 * Delegates to the shared finder in `github-reviewer` so status comments and review
 * comments resolve to *one* identity — that is what keeps a restarted run from
 * growing a second comment. If that finds nothing, a second pass adopts a comment
 * carrying the pre-unification `<!-- robin:status -->` marker, so a PR that was
 * reviewed before the upgrade continues to inherit instead of starting fresh.
 *
 * Best-effort: any API failure returns undefined so the caller falls back to creating a
 * comment instead of failing the run.
 */
export async function findLatestStatusComment(
  octokit: unknown,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<AdoptableStatusComment | undefined> {
  const current = await findExistingReviewComment(octokit, owner, repo, issueNumber);
  if (current) return current;

  const client = octokit as {
    paginate?: StatusCommentLister["paginate"];
    rest?: { issues?: { listComments?: unknown } };
  };
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
      const body = comment?.body;
      if (!Number.isFinite(id)) continue;
      // 与 findExistingReviewComment 同一判据。作者这半边最容易漏：人类复制一段
      // Robin 的旧评论（含 `<!-- robin:status -->`）再提问，就会被当成 Robin 自己的
      // 评论认领并整条覆盖 —— 覆盖掉人写的话不可恢复。宁可漏认领（多一条评论），
      // 也不能覆盖别人的字。
      if (comment?.user?.login !== ROBIN_BOT_LOGIN) continue;
      if (typeof body !== "string" || !body.includes(LEGACY_STATUS_COMMENT_MARKER)) continue;
      return { id, body };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/*
 * 以下三个函数原先住在 `main.ts`，是模块私有的。
 *
 * **为什么搬出来。** `main.ts` 一被 import 就整个 `run()` 起来，所以模块私有的
 * 辅助函数永远拿不到测试 —— 于是关于它们的行为只能写**源码扫描**式的断言，
 * 而扫描能防「被改坏」、防不了「逻辑本来就是错的」。R941 已用同一手法治过
 * 同类问题（把状态评论的正文构造器搬到这里），本轮是第二次。
 *
 * 搬动的直接收益：`resolveStatusCommentId` 是整条链的编排点
 * （认领或新建 → 清理其它 Robin 评论 → 返回 keepId），
 * 而 R1077 的缺陷恰恰只在**它与 hop 记账的组合**上出现。
 * 它现在可以被行为测试直接调用，而不必靠 main.ts 的源码扫描守着接线。
 *
 * 三个函数的名字与签名保持不变，所以 `main.ts` 的 11 个调用点一行未改。
 */
/**
 * Post Robin's single comment for this run — or adopt the one already there.
 *
 * Delegates to `publishRobinComment`, which does the paginated lookup and then either
 * PATCHes the existing marker-carrying comment or POSTs a new one. That is the entire
 * restart story: run 2 rewrites run 1's comment instead of adding a sibling, so a PR
 * whose review workflow failed twice still shows exactly one Robin comment.
 */
export async function postStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string,
  inheritedVerdict?: string
): Promise<number | undefined> {
  return publishRobinComment(
    octokit,
    owner,
    repo,
    issueNumber,
    buildInitialStatusBody(
      command === "summary" ? "summary" : "review",
      model,
      inheritedVerdict
    )
  );
}

export async function updateStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined,
  body: string
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: decorateStatusCommentBody(body),
    });
  } catch (error) {
    core.warning(`Could not update status comment: ${error}`);
  }
}

/**
 * Reuse the previous run's status comment when there is one.
 *
 * Every run used to create a fresh comment, so a PR reviewed several times carried several
 * "On it" comments and the newest could scroll out of view. A retried run now updates the
 * existing comment in place and carries the previous verdict forward, so the evaluation the
 * reader could already see is inherited instead of vanishing the moment a retry starts.
 *
 * Whichever branch it takes, it then drops Robin's *other* marked comments. Those only exist
 * on PRs reviewed before the marker was unified, but leaving them behind is exactly the
 * pile-up this function exists to remove. The cleanup requires all three of "carries the
 * marker", "authored by `github-actions[bot]`" and "is not the comment we just kept" —
 * the author check alone would reach unrelated comments from any other tool in the consumer
 * repo that comments as the default token (R1077).
 */
export async function resolveStatusCommentId(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string
): Promise<number | undefined> {
  const existing = await findLatestStatusComment(octokit, owner, repo, issueNumber);

  let statusCommentId: number | undefined;
  if (!existing) {
    statusCommentId = await postStatusComment(octokit, owner, repo, issueNumber, command, model);
  } else {
    const inheritedVerdict = extractInheritedVerdict(existing.body);
    core.info(
      `Adopting Robin status comment #${existing.id} from a previous run` +
        (inheritedVerdict ? ` (carrying over: ${inheritedVerdict})` : "")
    );
    await updateStatusComment(
      octokit,
      owner,
      repo,
      existing.id,
      buildInitialStatusBody(command === "summary" ? "summary" : "review", model, inheritedVerdict)
    );
    statusCommentId = existing.id;
  }

  const removed = await deletePreviousReviewComments(octokit, owner, repo, issueNumber, statusCommentId);
  if (removed > 0) {
    core.info(`Removed ${removed} duplicate Robin comment(s) from earlier runs.`);
  }
  return statusCommentId;
}