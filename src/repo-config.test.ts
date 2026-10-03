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
import { readFileSync } from "fs";
import { join } from "path";

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
    expect(resolveJsonResponseMode("false", { jsonResponseMode: true }).value).toBe(false);
    expect(resolveJsonResponseMode("true", { jsonResponseMode: false }).value).toBe(true);
    expect(resolveJsonResponseMode("", { jsonResponseMode: false }).value).toBe(false);
    expect(resolveJsonResponseMode("", undefined).value).toBe(true);
  });
});

describe("resolveRequestChanges", () => {
  it("prefers explicit action input, then repo config, then default true", () => {
    expect(resolveRequestChanges("false", { requestChanges: true }).value).toBe(false);
    expect(resolveRequestChanges("true", { requestChanges: false }).value).toBe(true);
    expect(resolveRequestChanges("", { requestChanges: false }).value).toBe(false);
    expect(resolveRequestChanges("", undefined).value).toBe(true);
  });
});

/**
 * R1085：两个解析器改为返回 `{value, valid}` —— 与同文件 `resolveMaxComments` /
 * `resolveMaxDiffSize` 同一套契约，让调用方**能告警**。
 *
 * 修的是什么：`use-json-response-mode` 在 `review.yml` 里是 `type: string`，
 * GitHub 不做任何归一化，原样透传；而解析器原先用精确比较 `=== "true"`。
 * 于是 `False` / `FALSE` / `" false"` 全部落空，**静默退回默认 true** ——
 * 用户明确写了要关，实际没关，且日志里一个字都没有。
 */
describe("布尔输入：归一化 + valid 契约（R1085）", () => {
  const spellingsThatMeanOff = ["false", "False", "FALSE", " false", "false ", "\tfalse"];
  const spellingsThatMeanOn = ["true", "True", "TRUE", " true", "true "];

  it("大小写与前后空白不再让「关」失效（原先只认精确的 \"false\"）", () => {
    for (const s of spellingsThatMeanOff) {
      expect(resolveJsonResponseMode(s, undefined)).toEqual({ value: false, valid: true });
      expect(resolveRequestChanges(s, undefined)).toEqual({ value: false, valid: true });
    }
    for (const s of spellingsThatMeanOn) {
      expect(resolveJsonResponseMode(s, undefined)).toEqual({ value: true, valid: true });
      expect(resolveRequestChanges(s, undefined)).toEqual({ value: true, valid: true });
    }
  });

  it("空串是正常的「未设置」，不是错误 —— 不该让调用方告警", () => {
    // 空串是 default: "" 的常态。若把它算成 invalid，告警就会每次运行都刷屏，
    // 真出问题时反而被噪音淹没。
    expect(resolveJsonResponseMode("", { jsonResponseMode: false })).toEqual({
      value: false,
      valid: true,
    });
    expect(resolveRequestChanges("", undefined)).toEqual({ value: true, valid: true });
  });

  it("无法识别的拼写 valid=false（供调用方告警），并明确告知取到的是什么", () => {
    // 刻意**不猜** no / off / 0：猜错比不猜更糟。所以返回 repoConfig ?? 默认，
    // 同时把 valid=false 交出去让调用方喊一声。
    for (const s of ["no", "off", "0", "maybe", "enabled"]) {
      expect(resolveJsonResponseMode(s, undefined)).toEqual({ value: true, valid: false });
      expect(resolveRequestChanges(s, undefined)).toEqual({ value: true, valid: false });
    }
    // repo config 仍然照旧生效（未设置 ≠ 拼错）
    expect(resolveJsonResponseMode("off", { jsonResponseMode: false })).toEqual({
      value: false,
      valid: false,
    });
  });

  it("显式输入优先于 repo config，且与原先的优先级完全一致", () => {
    expect(resolveJsonResponseMode("false", { jsonResponseMode: true })).toEqual({
      value: false,
      valid: true,
    });
    expect(resolveJsonResponseMode("true", { jsonResponseMode: false })).toEqual({
      value: true,
      valid: true,
    });
    expect(resolveRequestChanges("false", { requestChanges: true }).value).toBe(false);
    expect(resolveRequestChanges("", { requestChanges: false }).value).toBe(false);
  });
});

/**
 * `valid` 只有被 main.ts 用来告警才有意义。而这一段**没有任何自动化证据**：
 * `tsconfig` 没开 `noUnusedLocals`，所以把告警整块删掉之后 `tsc` 仍是绿的；
 * 上面那些行为测试测的是解析器，也仍全绿。唯一变化是**用户再也看不到告警** ——
 * 恰好是这个 guard 存在的理由。
 *
 * 两个值本身的类型是安全的（`jsonResponseMode` / `requestChanges` 都流向
 * `boolean` 形参，退回裸返回值会被 tsc 抓到），所以这里只钉「用了 valid 并告警」。
 * 扫描是弱证据（R1081 已记），但这里没有更便宜的办法。
 */
describe("main.ts 真的会用 valid 告警（源码扫描，R1085）", () => {
  const src = readFileSync(join(__dirname, "main.ts"), "utf8");

  const warnsAfter = (marker: string): string =>
    src.slice(src.indexOf(marker), src.indexOf(marker) + 320);

  it("两个解析结果都解构出 valid", () => {
    expect(src).toMatch(/const \{ value: jsonResponseMode, valid: jsonResponseModeValid \}/);
    expect(src).toMatch(/const \{ value: requestChanges, valid: requestChangesValid \}/);
  });

  it("valid 为假时确实发出告警，且告警里带上原始输入值", () => {
    for (const [flag, inputName] of [
      ["!jsonResponseModeValid", "jsonResponseModeInput"],
      ["!requestChangesValid", "requestChangesInput"],
    ] as const) {
      const seg = warnsAfter(flag);
      expect(seg.length).toBeGreaterThan(0); // 锚点必须真的存在，否则下面全是空断言
      expect(seg).toContain("core.warning");
      // 告警必须带上用户实际写的那串，否则等于没告警
      expect(seg).toContain(inputName);
    }
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
