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

/** Invisible marker that identifies a comment as Robin's status comment (never the review). */
export const STATUS_COMMENT_MARKER = "<!-- robin:status -->";

/** Prefix of the line that carries the previous run's verdict forward. */
export const LAST_RESULT_PREFIX = "> **Last result:** ";

/** Append the invisible marker to a status body. Idempotent. */
export function decorateStatusCommentBody(body: string): string {
  return body.includes(STATUS_COMMENT_MARKER) ? body : `${body}\n\n${STATUS_COMMENT_MARKER}`;
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
 * Best-effort: any API failure returns undefined so the caller falls back to creating a
 * comment instead of failing the run.
 */
export async function findLatestStatusComment(
  octokit: unknown,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<AdoptableStatusComment | undefined> {
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
      const comment = comments[i];
      const id = Number(comment?.id);
      const body = comment?.body;
      if (!Number.isFinite(id)) continue;
      if (typeof body !== "string" || !body.includes(STATUS_COMMENT_MARKER)) continue;
      return { id, body };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
