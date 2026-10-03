import { shouldRelaunchEmptyReview, shouldRetryStructuredReview } from "./review-retry";
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

  it.each(["high", "medium", "low", "suggestions"] as const)(
    "returns false when the %s bucket has findings",
    (bucket) => {
      // 四个桶逐个测：只测 medium 的话，countFindings 漏掉某个桶时变异会存活。
      expect(
        shouldRetryStructuredReview(
          emptyReview({
            [bucket]: [
              {
                severity: bucket === "suggestions" ? "suggestion" : bucket,
                category: "correctness",
                description: "Issue",
                recommendation: "Fix it",
              } as StructuredReview["high"][number],
            ],
          }),
          false
        )
      ).toBe(false);
    }
  );

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

describe("shouldRelaunchEmptyReview（R1091：重启必须在「真的重试过」之后）", () => {
  it("非 JSON + 0 发现 + 已重试 → 重启", () => {
    expect(shouldRelaunchEmptyReview(emptyReview(), false, true)).toBe(true);
  });

  it("非 JSON + 0 发现 + 未重试 → 不重启（修复点）", () => {
    // 正是这条被旧判据漏掉：块 A 因 summary 够长而决定不重试，
    // 块 B 却仍会重启，把真实 markdown 审查丢弃、还谎称 after retry。
    expect(shouldRelaunchEmptyReview(emptyReview(), false, false)).toBe(false);
  });

  it("干净 PR（合法 JSON、0 发现）即使重试过也绝不重启", () => {
    expect(shouldRelaunchEmptyReview(emptyReview(), true, true)).toBe(false);
    expect(shouldRelaunchEmptyReview(emptyReview(), true, false)).toBe(false);
  });

  it("有发现时绝不重启", () => {
    const withFinding = emptyReview({
      high: [
        {
          severity: "high",
          category: "correctness",
          description: "Issue",
          recommendation: "Fix it",
        },
      ],
    });
    expect(shouldRelaunchEmptyReview(withFinding, false, true)).toBe(false);
  });

  /**
   * 用**真实解析器输出**串起整条因果链，而不是手搓 StructuredReview：
   * 一条只有 `## Summary`、没有发现小节的 markdown 审查 ⇒ usedJson=false、0 发现、
   * summary 很长 ⇒ shouldRetry=false（块 A 不重试）⇒ shouldRelaunch(...,retried=false)
   * 必须为 false ⇒ main.ts 会走 postReview，把 summary 作为 review body 发出去。
   * 这正是 R1091 修复前会「丢弃 + 重启」的那个真实响应。
   */
  it("只有 Summary 的 markdown 审查：不重试，也不重启（真实解析器输出）", () => {
    const rawText = [
      "## Summary",
      "This pull request only reformats documentation and adds a comment;",
      "no behavioral change was found, so there is nothing to flag here.",
    ].join("\n");

    const parsed = ReviewParser.parseDetailed(rawText);

    // 前置条件：解析器确实把它当成非 JSON 的空审查。
    expect(parsed.usedJson).toBe(false);
    expect(parsed.findings.summary.length).toBeGreaterThan(40);

    const retry = shouldRetryStructuredReview(parsed.findings, parsed.usedJson);
    expect(retry).toBe(false); // 块 A：判定为真实 markdown 审查，不重试
    // 块 B：因为没有重试，绝不能重启 —— 否则 summary 被丢弃。
    expect(
      shouldRelaunchEmptyReview(parsed.findings, parsed.usedJson, retry)
    ).toBe(false);
  });
});
