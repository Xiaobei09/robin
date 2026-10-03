import {
  DEFAULT_MAX_COMMENTS,
  DEFAULT_ACTION_MAX_DIFF_SIZE,
  parseRepoConfigYaml,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
  resolveReasoningEffort,
  resolveRequestChanges,
} from "./repo-config";

describe("parseRepoConfigYaml", () => {
  it("parses supported keys", () => {
    const config = parseRepoConfigYaml(`
max-diff-size: 25000
max-comments: 8
json-response-mode: false
skip-paths:
  - "**/generated/**"
  - vendor/**
`);

    expect(config.maxDiffSize).toBe(25000);
    expect(config.maxComments).toBe(8);
    expect(config.jsonResponseMode).toBe(false);
    expect(config.skipPaths).toEqual(["**/generated/**", "vendor/**"]);
  });

  it("parses reasoning-effort as a case-preserving string", () => {
    expect(parseRepoConfigYaml("reasoning-effort: high").reasoningEffort).toBe("high");
    expect(parseRepoConfigYaml('reasoning-effort: "xhigh"').reasoningEffort).toBe("xhigh");
    expect(parseRepoConfigYaml("reasoning-effort: 'medium'").reasoningEffort).toBe("medium");
    expect(parseRepoConfigYaml("reasoning-effort: ProviderCustom").reasoningEffort).toBe(
      "ProviderCustom"
    );
  });

  it("leaves reasoning-effort unset when the repo config value is empty", () => {
    expect(parseRepoConfigYaml("reasoning-effort:").reasoningEffort).toBeUndefined();
    expect(parseRepoConfigYaml('reasoning-effort: ""').reasoningEffort).toBeUndefined();
  });

  it("tolerates the inline comments the shipped examples use", () => {
    expect(
      parseRepoConfigYaml("reasoning-effort: high   # provider-dependent; unset sends none")
        .reasoningEffort
    ).toBe("high");
    expect(
      parseRepoConfigYaml("request-changes: false # advisor mode").requestChanges
    ).toBe(false);
  });

  it("keeps a hash that is part of a quoted value", () => {
    expect(parseRepoConfigYaml('reasoning-effort: "provider#custom"').reasoningEffort).toBe(
      "provider#custom"
    );
    expect(parseRepoConfigYaml('reasoning-effort: "provider #custom"').reasoningEffort).toBe(
      "provider #custom"
    );
    expect(
      parseRepoConfigYaml('reasoning-effort: "provider #custom" # trailing note').reasoningEffort
    ).toBe("provider #custom");
  });

  it("strips an inline comment containing an apostrophe", () => {
    expect(
      parseRepoConfigYaml("reasoning-effort: high   # provider's note").reasoningEffort
    ).toBe("high");
  });

  it("handles escaped quotes and multi-word unquoted values", () => {
    expect(parseRepoConfigYaml('reasoning-effort: "a\\"b" # note').reasoningEffort).toBe('a"b');
    expect(parseRepoConfigYaml("reasoning-effort: very high").reasoningEffort).toBe("very high");
  });
});

describe("resolveMaxDiffSize", () => {
  it("uses repo config when action input is still the default", () => {
    expect(
      resolveMaxDiffSize(String(DEFAULT_ACTION_MAX_DIFF_SIZE), { maxDiffSize: 25000 }).value
    ).toBe(25000);
  });

  it("keeps explicit action input over repo config", () => {
    expect(resolveMaxDiffSize("12000", { maxDiffSize: 25000 }).value).toBe(12000);
  });
});

describe("resolveMaxComments", () => {
  it("uses repo config when action input is still the default", () => {
    expect(
      resolveMaxComments(String(DEFAULT_MAX_COMMENTS), { maxComments: 8 }).value
    ).toBe(8);
  });

  it("honors an explicit non-default action input over repo config", () => {
    expect(resolveMaxComments("5", { maxComments: 8 }).value).toBe(5);
  });

  it("honors max-comments 0 from repo config", () => {
    expect(resolveMaxComments(String(DEFAULT_MAX_COMMENTS), { maxComments: 0 }).value).toBe(0);
  });
});

describe("resolveJsonResponseMode", () => {
  it("prefers explicit action input, then repo config, then default true", () => {
    expect(resolveJsonResponseMode("false", { jsonResponseMode: true })).toBe(false);
    expect(resolveJsonResponseMode("true", { jsonResponseMode: false })).toBe(true);
    expect(resolveJsonResponseMode("", { jsonResponseMode: false })).toBe(false);
    expect(resolveJsonResponseMode("", undefined)).toBe(true);
  });
});

describe("resolveRequestChanges", () => {
  it("prefers explicit action input, then repo config, then default true", () => {
    expect(resolveRequestChanges("false", { requestChanges: true })).toBe(false);
    expect(resolveRequestChanges("true", { requestChanges: false })).toBe(true);
    expect(resolveRequestChanges("", { requestChanges: false })).toBe(false);
    expect(resolveRequestChanges("", undefined)).toBe(true);
  });
});

describe("resolveReasoningEffort", () => {
  it("prefers a non-empty action input over repo config and trims it", () => {
    expect(resolveReasoningEffort("  low ", { reasoningEffort: "high" })).toBe("low");
  });

  it("falls back to repo config when the input is empty or whitespace", () => {
    expect(resolveReasoningEffort("", { reasoningEffort: "high" })).toBe("high");
    expect(resolveReasoningEffort("   ", { reasoningEffort: "high" })).toBe("high");
  });

  it("stays unset when neither the input nor repo config sets it", () => {
    expect(resolveReasoningEffort("", undefined)).toBeUndefined();
    expect(resolveReasoningEffort("  ", {})).toBeUndefined();
  });
});

/**
 * R947：`parseInt` 把拼写错误**静默变成一个合法但完全不同的数**，而不是拒绝它。
 *
 * 实测（改前，全部来自真解析器）：
 *   "1e3"   parseInt→1     本意 1000 ⇒ max-diff-size=1，diff 被截到 1 字符
 *   "1_000" parseInt→1
 *   "0x10"  parseInt→0     radix 10 停在 "x" ⇒ max-comments=0，关掉全部内联评论
 *   "0b11"  parseInt→0
 *   "0o17"  parseInt→0
 *   "0abc"  parseInt→0
 *
 * 这类输入最坏的地方在于结果**自洽**：拿到 1 或 0 的人看不出任何异常，
 * 而「拒绝并回落默认」至少有明确语义。改用 `Number()` + 整数校验，
 * 与 `parseLLMTimeout` / `parseLLMTemperature` 已是同一套制度。
 */
describe("严格数字解析：拼写错误必须被拒绝而不是被静默改写（R947）", () => {
  /** 这些正是 parseInt 会给出「合法但不同」答案的输入。 */
  const SILENTLY_CORRUPTED = [
    "1e3",
    "1.5e2",
    "1_000",
    "0x10",
    "0b11",
    "0o17",
    "0abc",
    "15abc",
    "7px",
  ];

  it.each(SILENTLY_CORRUPTED)("max-comments 拒绝 %j（改前会静默变成 0 或 15）", (input) => {
    const r = resolveMaxComments(input);
    expect({ input, valid: r.valid }).toEqual({ input, valid: false });
    // 拒绝后必须回落到默认值，而不是留下任何「半解析」的结果
    expect(r.value).toBe(DEFAULT_MAX_COMMENTS);
  });

  it.each(SILENTLY_CORRUPTED)("max-diff-size 拒绝 %j（改前会静默变成 1）", (input) => {
    const r = resolveMaxDiffSize(input);
    expect({ input, valid: r.valid }).toEqual({ input, valid: false });
    expect(r.value).toBe(DEFAULT_ACTION_MAX_DIFF_SIZE);
  });

  it("空串不得变成 0：Number('') === 0，不拦就把「未设置」变成「关掉所有内联评论」", () => {
    // 这是整个改动里最危险的一步。parseInt("") 是 NaN（安全），
    // 而 Number("") 是 0 —— 直接换函数会把一个安全行为换成一个危险行为。
    expect(resolveMaxComments("").valid).toBe(false);
    expect(resolveMaxComments("").value).toBe(DEFAULT_MAX_COMMENTS);
    expect(resolveMaxDiffSize("").valid).toBe(false);
    expect(resolveMaxDiffSize("").value).toBe(DEFAULT_ACTION_MAX_DIFF_SIZE);
    // 纯空白同理
    expect(resolveMaxComments("   ").valid).toBe(false);
    expect(resolveMaxComments("   ").value).toBe(DEFAULT_MAX_COMMENTS);
  });

  it("合法值原样保留且标记为有效", () => {
    // 纯十进制数字。前导/尾随空白容忍（core.getInput 本身会 trim，
    // 但直接调解析器时不该因此拒绝）。
    for (const good of ["0", "1", "7", "15", " 7 ", "007"]) {
      const mc = resolveMaxComments(good);
      expect({ good, valid: mc.valid }).toEqual({ good, valid: true });
      // 期望值写成字面量表，而不是 parseInt(good, 10)：后者会在解析器退回
      // parseInt 时自动跟着变，断言就永远不会红（自我揭发的反面：自我掩盖）。
      expect(mc.value).toBe(Number(good.trim()));
    }
    expect(resolveMaxDiffSize("12000")).toEqual({ value: 12000, valid: true });
  });

  it("带符号/非纯数字形态被拒绝（与 parseRepoConfigYaml 的 \\d+ 规则一致）", () => {
    // .github/robin.yml 那侧用的是 /^max-comments:\\s*(\\d+)\\s*$/i，只认纯数字。
    // action input 这侧曾经宽松，两侧规则不一致本身就是隐患。
    for (const bad of ["+4", "-3", "1.9", " 7 px", "7_"]) {
      expect(resolveMaxComments(bad).valid).toBe(false);
    }
  });

  it("下溢到 0 被拒绝（\"1e-400\" → Number() 是 0，会静默关掉所有内联评论）", () => {
    expect(Number("1e-400")).toBe(0); // 先确认这个洞是真的
    expect(resolveMaxComments("1e-400").valid).toBe(false);
    expect(resolveMaxComments("1e-400").value).toBe(DEFAULT_MAX_COMMENTS);
  });

  it("0 是合法值（关掉内联评论），不能被区间检查误拒", () => {
    // 判据必须区分「0」与「没有值」—— 用真值判断会把这个合法配置误判成未设置。
    expect(resolveMaxComments("0")).toEqual({ value: 0, valid: true });
    expect(resolveMaxComments("0").valid).toBe(true);
  });

  it("非整数与负数被拒绝（计数与字符预算没有小数的意义）", () => {
    expect(resolveMaxComments("1.9")).toEqual({ value: DEFAULT_MAX_COMMENTS, valid: false });
    expect(resolveMaxComments("-3")).toEqual({ value: DEFAULT_MAX_COMMENTS, valid: false });
    expect(resolveMaxDiffSize("1.9")).toEqual({ value: DEFAULT_ACTION_MAX_DIFF_SIZE, valid: false });
    expect(resolveMaxDiffSize("-3")).toEqual({ value: DEFAULT_ACTION_MAX_DIFF_SIZE, valid: false });
    // max-diff-size 要求 > 0，0 无意义
    expect(resolveMaxDiffSize("0")).toEqual({ value: DEFAULT_ACTION_MAX_DIFF_SIZE, valid: false });
  });

  it("被拒绝时 .github/robin.yml 仍然能赢（乱码不是有效意图）", () => {
    expect(resolveMaxComments("1e3", { maxComments: 8 }).value).toBe(8);
    expect(resolveMaxDiffSize("0x10", { maxDiffSize: 9 }).value).toBe(9);
    // 但显式的合法值仍然压过 repo config
    expect(resolveMaxComments("3", { maxComments: 8 }).value).toBe(3);
    expect(resolveMaxDiffSize("9", { maxDiffSize: 3 }).value).toBe(9);
  });

  it("哨兵语义未被严格化破坏：等于默认常量时 repo config 依然赢", () => {
    expect(resolveMaxComments(String(DEFAULT_MAX_COMMENTS), { maxComments: 8 }).value).toBe(8);
    expect(resolveMaxDiffSize(String(DEFAULT_ACTION_MAX_DIFF_SIZE), { maxDiffSize: 9 }).value).toBe(9);
  });
});
