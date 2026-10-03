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
   * R1070：无关围栏**遮蔽**真 JSON。
   *
   * 旧实现只要看到 ``` 围栏就提前返回该块内容，配对扫描这层兜底一次都不执行。
   * 模型在正文里贴代码片段是常态，于是：
   *   ```ts  const a = { x: 1 };  ```   ← 围栏块，非 JSON
   *   {"summary":…,"high":[…]}          ← 真正的 review JSON
   * 提前返回 ⇒ JSON.parse 失败 ⇒ usedJson=false + findings 全空
   * ⇒ main.ts 的 `count===0 && !usedJson` 命中 ⇒ 带真实高危发现的 PR 被白白重开 CI。
   *
   * 与上面「散文花括号污染合法 JSON」同一族、方向相反：那次污染，这次遮蔽。
   */
  describe("R1070：无关围栏不得遮蔽真 JSON", () => {
    const review = {
      summary: "Auth check is missing on one path.",
      high: [{ severity: "high", description: "Unauthenticated path", file: "src/auth.ts", line: 12 }],
    };
    const reviewJson = JSON.stringify(review);

    it("前置 ts 围栏（装代码片段）之后仍能取到真 review JSON", () => {
      const raw = ["Here is the relevant code:", "```ts", "const a = { x: 1 };", "```", "And my review:", reviewJson].join("\n");
      const parsed = ReviewParser.parseDetailed(raw);
      expect(parsed.usedJson).toBe(true);
      expect(parsed.findings.high).toHaveLength(1);
      expect(parsed.findings.high[0].description).toBe("Unauthenticated path");
      expect(parsed.findings.summary).toBe("Auth check is missing on one path.");
    });

    it("多个围栏块时取第一个真正是 JSON 的那个", () => {
      const raw = [
        "Setup:",
        "```bash",
        "npm install",
        "```",
        "Output:",
        "```",
        "added 3 packages",
        "```",
        "Review:",
        "```json",
        reviewJson,
        "```",
      ].join("\n");
      const parsed = ReviewParser.parseDetailed(raw);
      expect(parsed.usedJson).toBe(true);
      expect(parsed.findings.high).toHaveLength(1);
    });

    it("```json 围栏里的合法 JSON 仍走优先路径（不得被后面的裸 JSON 抢走）", () => {
      const fenced = JSON.stringify({ summary: "fenced wins", high: [] });
      const parsed = ReviewParser.parseDetailed(["```json", fenced, "```"].join("\n"));
      expect(parsed.usedJson).toBe(true);
      expect(parsed.findings.summary).toBe("fenced wins");
    });

    it("只有一个非 JSON 围栏、且全文确实没有 JSON 时仍然 fail-closed", () => {
      // 修复不能把 fail-closed 放松成「总能 parse 出点什么」。
      const parsed = ReviewParser.parseDetailed(["```ts", "const a = { x: 1 };", "```"].join("\n"));
      expect(parsed.usedJson).toBe(false);
    });

    it("非 JSON 围栏在**后**置时同样不遮蔽前面的真 JSON", () => {
      const raw = [reviewJson, "```", "trailing log line", "```"].join("\n");
      const parsed = ReviewParser.parseDetailed(raw);
      expect(parsed.usedJson).toBe(true);
      expect(parsed.findings.high).toHaveLength(1);
    });
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

/**
 * 定位信息（file/line）必须**指向 PR 里真实存在的位置**，否则内联评论要么被丢、
 * 要么落到错误的行上。
 *
 * 旧的 fallback 分别跑两个正则：`filePattern` 取整句里**第一个** `xxx.ext`，
 * `linePattern` 取整句里**第一个** `:数字`。散文里的东西于是全被当成定位信息
 * （以下全部走真 ReviewParser.parseDetailed 实测）：
 *
 *   "- At 09:05 the code in src/auth.ts:42 ran."
 *        => file="src/auth.ts"  line=5     ← 文件对了、行号错了
 *   "- ... e.g. retries twice in src/auth.ts:42."
 *        => file="e.g"          line=30
 *   "- Version 1.5 introduced this, see src/auth.ts:42 above."
 *        => file="1.5"          line=42
 *   "- Endpoint https://example.com:8080/v1 fails, see src/auth.ts:42."
 *        => file="https://example.com"  line=8080
 *   "- This is a general design concern, e.g. about naming."
 *        => file="e.g"          line=undefined
 *
 * 第一条最毒：文件名对了、行号错了。而 `GitHubReviewer.isLineInNewDiff` 只检查行号
 * 是否落在该文件的 diff 范围内 —— 5 行若在 diff 里就会**放行**，于是评论被发到
 * `src/auth.ts:5`，模型写的却是 `:42`。这是会误导审查者的错位评论。
 *
 * 其余几条的下游后果稍轻：`files.find(f => f.filename === finding.file)` 找不到
 * 就会 warning 后整条丢弃，所以不会污染 GitHub review；但模型给出的真实发现就
 * 此**静默消失**了，只在日志里留一条 warning。
 */
describe("定位信息：散文里的东西不能被当成 file/line", () => {
  const high = (bullet: string) =>
    `### Summary\nok\n\n### High Issues (must fix)\n${bullet}\n`;
  const only = (bullet: string) => ReviewParser.parseDetailed(high(bullet)).findings.high[0];

  it("时间在前、文件名在后时，行号取自文件名而不是时间", () => {
    const f = only("- At 09:05 the code in src/auth.ts:42 ran.");
    expect(f).toMatchObject({ file: "src/auth.ts", line: 42 });
  });

  it("散文里的 e.g. 不会被当成文件名，时间不会被当成行号", () => {
    const f = only("- It runs at 10:30 and e.g. retries twice in src/auth.ts:42.");
    expect(f).toMatchObject({ file: "src/auth.ts", line: 42 });
  });

  it("版本号 1.5 不会被当成文件名", () => {
    const f = only("- Version 1.5 introduced this, see src/auth.ts:42 above.");
    expect(f).toMatchObject({ file: "src/auth.ts", line: 42 });
  });

  it("URL 不会被当成文件名，端口不会被当成行号", () => {
    const f = only("- Endpoint https://example.com:8080/v1 fails, see src/auth.ts:42.");
    expect(f).toMatchObject({ file: "src/auth.ts", line: 42 });
  });

  it("完全没有定位信息的散文不编造文件名", () => {
    const f = only("- This is a general design concern, e.g. about naming.");
    expect(f?.file).toBeUndefined();
    expect(f?.line).toBeUndefined();
    // 描述本身必须完好——不能因为定位抽不出来就把发现一起丢掉
    expect(f?.description).toContain("design concern");
  });

  it("只有文件名、没有行号时仍保留文件名", () => {
    // 行号缺失时 GitHubReviewer 会跳过内联评论，但 location 文案里还会显示文件名，
    // 所以这条能力要留住。
    const f = only("- See src/auth.ts for the whole picture.");
    expect(f).toMatchObject({ file: "src/auth.ts" });
    expect(f?.line).toBeUndefined();
  });

  it("裸路径带行号时照常取到（无目录前缀的文件名）", () => {
    const f = only("- README.md:12 needs clarification.");
    expect(f).toMatchObject({ file: "README.md", line: 12 });
  });
});

/**
 * 行号在文件里不可能是 0、负数或小数。
 *
 * 旧的 `asNumber` 只判 `Number.isFinite`，而 `/^\d+$/` 只管字符串分支，number 分支
 * 直接放行，于是 `line: 0` / `line: -5` / `line: 1.5` / `line: 99999999` 全被接受
 * （实测四项都原样出现在解析结果里）。
 *
 * 下游目前**恰好**挡得住：`!finding.line` 丢掉 0，`isLineInNewDiff` 丢掉其余。
 * 但那是两道「恰好挡下」的护栏，不是「本来就合法」—— 有人改下游就会退化。
 */
describe("line 必须是 1 起的整数", () => {
  const lineOf = (raw: string) =>
    ReviewParser.parseDetailed(raw).findings.high[0]?.line;

  // 只列「不可能是行号」的值。99999999 **刻意不在这里** —— 它是正整数, 语法上合法,
  // 是否合理该由「这个文件有没有这么多行」回答, 而那是 isLineInNewDiff 的职责。
  it.each([
    ["0", 0],
    ["负数", -5],
    ["小数", 1.5],
  ])("line 为 %s 时被拒（实测这些原本都会被接受）", (_name, value) => {
    expect(lineOf(`{"summary":"s","high":[{"file":"a.ts","line":${value},"description":"d"}]}`))
      .toBeUndefined();
  });

  it("正整数原样保留", () => {
    expect(lineOf('{"summary":"s","high":[{"file":"a.ts","line":42,"description":"d"}]}')).toBe(42);
  });

  it("纯十进制字符串行号仍被接受（字符串分支不得一起废掉）", () => {
    expect(lineOf('{"summary":"s","high":[{"file":"a.ts","line":"42","description":"d"}]}')).toBe(42);
  });

  /**
   * 行号**刻意不设上界**。
   *
   * 一开始我写了一条「99999999 应被拒」的断言, 实现没满足, 但复查后判定**断言错、
   * 代码对**：它是正整数, 语法上完全可能是某个超大文件的真实行号。要判断它是否
   * 合理, 得知道「这个文件有多少行」—— 那是 `GitHubReviewer.isLineInNewDiff` 的职责
   * （它只放行落在该文件 diff 范围内的行号）。
   *
   * 而在这里加一个魔数上界**不改善任何后果**：99999999 行本来就被 isLineInNewDiff
   * 挡掉并 warning 后丢弃, 加了上界只是把丢弃提前到解析器, 结果完全一样, 反而
   * 引入一个新的可动变量（该定多大? 十万? 百万? 会不会误伤真实大文件?）。
   * 能被安全拒掉的只有「不可能是行号」的那些：0、负数、小数。
   */
  it("不给行号设上界：超大正整数原样保留, 由下游按 diff 范围判定", () => {
    expect(lineOf('{"summary":"s","high":[{"file":"a.ts","line":99999999,"description":"d"}]}'))
      .toBe(99999999);
  });

  it("非十进制字符串行号被拒", () => {
    expect(lineOf('{"summary":"s","high":[{"file":"a.ts","line":"4.2","description":"d"}]}')).toBeUndefined();
  });
});

