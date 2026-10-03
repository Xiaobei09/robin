import { shouldRetryStructuredReview } from "./review-retry";
import { ReviewParser, StructuredReview } from "./review-parser";

function emptyReview(overrides: Partial<StructuredReview> = {}): StructuredReview {
  return {
    summary: "",
    high: [],
    medium: [],
    low: [],
    suggestions: [],
    rawResponse: "",
    ...overrides,
  };
}

describe("shouldRetryStructuredReview", () => {
  it("does not retry valid JSON with empty findings and a summary", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({ summary: "No issues found in this focused change." }),
        true
      )
    ).toBe(false);
  });

  it("retries when JSON was not used and there are no findings", () => {
    expect(shouldRetryStructuredReview(emptyReview(), false)).toBe(true);
  });

  it("does not retry markdown fallback with a substantive summary", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({
          summary:
            "This pull request updates documentation only. No code risks were identified in the diff.",
        }),
        false
      )
    ).toBe(false);
  });

  it("returns false when any severity bucket has findings", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({
          medium: [
            {
              severity: "medium",
              category: "correctness",
              description: "Issue",
              recommendation: "Fix it",
            },
          ],
        }),
        false
      )
    ).toBe(false);
  });

  /**
   * 与 extractJsonObject 的围栏修复配对的断言。
   *
   * 这两个模块是一条因果链的两端，单独测任一个都会漏：
   *   parseDetailed 因围栏遮蔽而 usedJson=false + findings 全空
   *   → shouldRetryStructuredReview 看到 count===0 && !usedJson ⇒ 返回 true
   *   → main.ts 重开 CI（审查结论丢失）
   * 所以这里用**解析器的真实输出**当输入，而不是手搓一个假的 StructuredReview。
   */
  it("does not request a CI relaunch when a real finding was hidden behind a code fence", () => {
    const rawText = [
      "Here is the relevant code:",
      "```ts",
      "const a = { x: 1 };",
      "```",
      "And my review:",
      '{"summary":"found a bug","high":[{"severity":"high","description":"real finding","file":"src/a.ts","line":3}]}',
    ].join("\n");

    const parsed = ReviewParser.parseDetailed(rawText);

    // 前置条件：解析器必须真的把高危发现捞出来。
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.high).toHaveLength(1);

    // 因果链的后端：既然有发现，就绝不能要求重开 CI。
    expect(shouldRetryStructuredReview(parsed.findings, parsed.usedJson)).toBe(false);
  });
});
