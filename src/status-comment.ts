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

import {
  ROBIN_BOT_LOGIN,
  ROBIN_SIGNATURE,
  REVIEW_MARKER,
  decorateRobinCommentBody,
  findExistingReviewComment,
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

