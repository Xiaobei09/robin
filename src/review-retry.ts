import { StructuredReview } from "./review-parser";

const RETRY_SUMMARY_MAX_LENGTH = 40;

/** 四个严重度桶的总数。**只此一处**统计，避免 main.ts 再手写一遍求和。 */
export function countFindings(findings: StructuredReview): number {
  return (
    findings.high.length +
    findings.medium.length +
    findings.low.length +
    findings.suggestions.length
  );
}

export function shouldRetryStructuredReview(
  findings: StructuredReview,
  usedJson: boolean
): boolean {
  if (countFindings(findings) > 0) return false;
  if (usedJson) return false;

  return findings.summary.trim().length <= RETRY_SUMMARY_MAX_LENGTH;
}

/**
 * 是否该在「解析失败」时重启 CI。
 *
 * R1091：这里必须要求 `retried === true`。旧判据只有
 * 「`countFindings === 0 && !usedJson`」，它**严格宽于** `shouldRetryStructuredReview`：
 * 唯一差集是「非 JSON、0 条发现、summary 超过 40 字」。那种响应块 A 判定为
 * **真实 markdown 审查**（不值得再问一遍 JSON），块 B 却把它**丢弃并重启 CI**，
 * 失败消息还谎称 `after retry` —— 而根本没有重试过。`postReview` 会使用
 * `findings.summary`（`github-reviewer.ts` 的 `buildReviewBody`），
 * 所以丢掉的是真审查输出，还白烧一次 CI。
 *
 * 加上 `retried` 之后，语义与 `main.ts` 的注释「两次都没能产出 JSON」以及
 * 失败消息里的 `after retry` **逐字一致**：只有先做过一次 JSON-only 重试、
 * 且重试后仍然 `!usedJson && 0 发现`，才重启。
 *
 * `usedJson === true && 0 发现` 是干净 PR 的正常形态（模型给了合法 JSON、
 * 只是没问题），**绝不重启** —— 这条没有随 `retried` 放松。
 */
export function shouldRelaunchEmptyReview(
  findings: StructuredReview,
  usedJson: boolean,
  retried: boolean
): boolean {
  return retried && !usedJson && countFindings(findings) === 0;
}
