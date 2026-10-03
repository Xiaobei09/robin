import { ReviewParser } from "./review-parser";

describe("ReviewParser", () => {
  it("parses strict JSON review output", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "Good structure, but one risky auth path needs work.",
        high: [
          {
            file: "src/auth.ts",
            line: 42,
            category: "security",
            description: "Missing authorization check before returning account data.",
            recommendation: "Check that the requester owns the account before returning it.",
            codeSnippet: "if (account.userId !== user.id) throw new Error('Forbidden');",
          },
        ],
        medium: [],
        low: [],
        suggestions: [],
      })
    );

    expect(review.summary).toContain("Good structure");
    expect(review.high).toHaveLength(1);
    expect(review.high[0]).toMatchObject({
      severity: "high",
      file: "src/auth.ts",
      line: 42,
      category: "security",
    });
  });

  it("parses confidence when present and ignores invalid values", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "ok",
        high: [
          { line: 1, description: "real bug", recommendation: "fix", confidence: "High" },
        ],
        medium: [
          { line: 2, description: "maybe", recommendation: "fix", confidence: "definitely" },
        ],
        low: [],
        suggestions: [],
      })
    );

    expect(review.high[0].confidence).toBe("high");
    expect(review.medium[0].confidence).toBeUndefined();
  });

  it("parses JSON inside a code fence", () => {
    const review = ReviewParser.parse(`Here is the review:\n\n\`\`\`json
{
  "summary": "Looks safe overall.",
  "high": [],
  "medium": [
    {
      "file": "src/main.ts",
      "line": "12",
      "category": "reliability",
      "description": "Timeout errors are not handled.",
      "recommendation": "Catch timeout errors and retry once."
    }
  ],
  "low": [],
  "suggestions": []
}
\`\`\``);

    expect(review.medium).toHaveLength(1);
    expect(review.medium[0].line).toBe(12);
  });

  it("accepts legacy critical and important JSON keys as high and medium", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "Legacy shape.",
        critical: [
          {
            file: "src/auth.ts",
            line: 42,
            category: "security",
            description: "Missing authorization check.",
            recommendation: "Add an authorization guard.",
          },
        ],
        important: [
          {
            file: "src/main.ts",
            line: 12,
            category: "reliability",
            description: "No timeout handling.",
            recommendation: "Catch timeout errors.",
          },
        ],
        suggestions: [],
      })
    );

    expect(review.high).toHaveLength(1);
    expect(review.high[0].severity).toBe("high");
    expect(review.medium).toHaveLength(1);
    expect(review.medium[0].severity).toBe("medium");
  });

  it("falls back to markdown headings and bullet findings", () => {
    const review = ReviewParser.parse(`### Summary
The change is focused and easy to follow.

### High Issues (must fix)
- src/auth.ts:42 -- Missing authorization check before returning account data.

### Medium Issues (should fix)
- None

### Low Issues
- src/index.ts:2 -- Export name is slightly unclear.

### Suggestions (nice to have)
1. README.md:12 - Clarify the setup instructions.
`);

    expect(review.summary).toContain("focused");
    expect(review.high).toHaveLength(1);
    expect(review.high[0]).toMatchObject({
      file: "src/auth.ts",
      line: 42,
      description: "Missing authorization check before returning account data.",
    });
    expect(review.medium).toHaveLength(0);
    expect(review.low).toHaveLength(1);
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0].file).toBe("README.md");
  });


});

/**
 * 花括号在散文里极常见（"the {id} field"、"e.g. {config}"）。
 *
 * 旧实现从**第一个** `{` 贪心切到**最后一个** `}`，于是散文的括号会与真正的
 * JSON 粘成一个字符串，`JSON.parse` 必然失败，`usedJson` 变成 false。而
 * `main.ts` 的重开判定正是 `count === 0 && !usedJson` ⇒ 一个**JSON 完全合法**的
 * 干净 PR，只要模型的散文里提到过 `{...}`，就会被判成「模型没给出 JSON」，
 * 白白重开一个 CI（还先浪费一次 llm 重试）。
 *
 * 这条断言钉的是「合法的 JSON 不该因为外面裹了散文就被判无效」。
 */
describe("extractJsonObject：合法 JSON 不被散文里的花括号污染", () => {
  const clean = '{"summary":"No issues found.","high":[],"medium":[],"low":[],"suggestions":[]}';

  const wrapped: Array<[string, string]> = [
    ["前置散文带花括号", `I looked at {this} carefully.\n${clean}`],
    ["后置散文带花括号", `${clean}\nNote: {this} is fine.`],
    ["两端都带花括号", `{pre} text\n${clean}\n{post}`],
    ["散文里是 JSON 片段", `Consider {\"k\": 1} shape.\n${clean}`],
  ];

  it.each(wrapped)("%s 仍然被判为 JSON 模式", (_name, raw) => {
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe("No issues found.");
  });

  it("真正没有 JSON 时仍然是 non-JSON（不得为了上面几条而放松）", () => {
    // fail-closed 的另一半：没有 JSON 就必须判成 non-JSON，否则 main.ts 的
    // 重开判定会彻底失效（这是 R927 的核心触发面）。
    const parsed = ReviewParser.parseDetailed("Everything looks good to me.");
    expect(parsed.usedJson).toBe(false);
  });

  it("括号写在 JSON 字符串内部时按配对取值，不被截断", () => {
    const raw = '{"summary":"use {id} as the key","high":[]}';
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe("use {id} as the key");
  });

  /**
   * 这一组钉的是「取最长」而不是「第一个能 parse 就用」的理由。
   *
   * 如果只取第一个，散文里的 `{"k": 1}` 会成为 review JSON：summary 取不到、
   * findings 全空，于是**静默漏审** —— 模型明明给了 findings，robin 却什么都不报，
   * 还以为这是干净 PR。fail-closed 被破成 fail-open，比白重开一次 CI 严重得多。
   */
  it("散文里带合法 JSON 片段时，真正的 findings 不能被那个片段吞掉", () => {
    const review = {
      summary: "One auth path is missing a check.",
      high: [{ file: "src/auth.ts", line: 42, description: "Missing authorization check." }],
    };
    const raw = `Consider {"k": 1} and {"other": "shape"} shapes.\n${JSON.stringify(review)}`;
    const parsed = ReviewParser.parseDetailed(raw);

    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.high).toHaveLength(1);
    expect(parsed.findings.high[0]).toMatchObject({ file: "src/auth.ts", line: 42 });
  });

  it("R927 的重开判定：JSON 合法即使用户散文带花括号也不触发", () => {
    // main.ts:452 的触发面是 `count === 0 && !usedJson`。
    const clean = '{"summary":"No issues found.","high":[],"medium":[],"low":[],"suggestions":[]}';
    const wrapped = `I checked {id}, {name} and {config}.\n${clean}`;
    const parsed = ReviewParser.parseDetailed(wrapped);
    const count =
      parsed.findings.high.length +
      parsed.findings.medium.length +
      parsed.findings.low.length +
      parsed.findings.suggestions.length;

    expect(count).toBe(0);
    expect(parsed.usedJson).toBe(true);
    // 直接把 main.ts 的判定式抄过来断言，避免「解析器绿了但重开面没收窄」
    expect(count === 0 && !parsed.usedJson).toBe(false);
  });

  /**
   * 下面两条补的是「配对扫描」的两条分支缺口，变异实测发现的：
   * M51（删掉字符串状态判断）与 M53（删掉转义处理）在原先的测试下**都存活**。
   *
   * 原先那条「括号写在 JSON 字符串内部」用的是 `{id}` —— **配对**的括号，
   * 所以即便完全不区分字符串内外，深度照样归零，测不出差别。要暴露差异必须用
   * **不配对**的 `{`；转义同理，要靠值里真的出现 `\"`。
   */
  it("字符串里出现【不配对】的左花括号时，仍能正确配对", () => {
    // 不区分字符串内外的话，这里的 { 会让深度永不归零 => 整个候选被判无效
    // => usedJson 变 false => 又回到「合法 JSON 被误判」那个缺陷上。
    const raw = '{"summary":"use {id as the key","high":[],"medium":[],"low":[],"suggestions":[]}';
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe("use {id as the key");
  });

  it("字符串值里含转义引号时，配对不被提前截断", () => {
    // 不处理转义的话，\" 里的引号会被当成字符串结束符，之后的深度计算全错。
    const raw = '{"summary":"say \\"hi\\" now","high":[],"medium":[],"low":[],"suggestions":[]}';
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe('say "hi" now');
  });

  it("转义引号后面跟着右花括号时，仍按字面量处理而非结束符", () => {
    const raw = '{"summary":"ends with a brace \\"}","high":[]}';
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe('ends with a brace "}');
  });

  it("散文在 JSON 之后且含成对花括号时，取到的是那个 JSON 而不是更大的切片", () => {
    const raw = '{"summary":"ok","high":[]}\nAlso check {other} keys.';
    const parsed = ReviewParser.parseDetailed(raw);
    expect(parsed.usedJson).toBe(true);
    expect(parsed.findings.summary).toBe("ok");
  });
});
