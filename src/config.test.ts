import {
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_COMPLETION_ATTEMPTS,
  MAX_LLM_TEMPERATURE,
  MIN_LLM_COMPLETION_ATTEMPTS,
  parseLLMMaxAttempts,
  parseLLMTemperature,
  parseLLMTimeout,
  parseStrictNumber,
} from "./config";
import { readFileSync } from "fs";
import { join } from "path";

describe("parseLLMTimeout", () => {
  it("reports empty input as 'not configured' rather than a concrete number", () => {
    // R1072：未配置必须表达成 `undefined`，不能塌回 DEFAULT_LLM_TIMEOUT_MS。
    // 一旦塌回去，resolveLlmTimeoutMs 就无法区分「没配」与「显式配了 600000」，
    // 后者会被对 OpenRouter 路由模型静默降级成 120000ms。
    const result = parseLLMTimeout("");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("parses a valid positive integer string", () => {
    const result = parseLLMTimeout("300000");
    expect(result.value).toBe(300000);
    expect(result.valid).toBe(true);
  });

  it("parses a positive float string", () => {
    // Number() preserves 5000.5 -> 5000.5
    const result = parseLLMTimeout("5000.5");
    expect(result.value).toBe(5000.5);
    expect(result.valid).toBe(true);
  });

  it("falls back for NaN string", () => {
    const result = parseLLMTimeout("not-a-number");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("falls back for negative values", () => {
    const result = parseLLMTimeout("-1000");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("falls back for zero", () => {
    const result = parseLLMTimeout("0");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("falls back for whitespace-only string", () => {
    const result = parseLLMTimeout("   ");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });
});

describe("parseLLMTemperature", () => {
  it("returns the default for empty input", () => {
    const result = parseLLMTemperature("");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(true);
  });

  it("returns the default for whitespace-only input", () => {
    const result = parseLLMTemperature("  ");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(true);
  });

  it("parses the fixed temperature some models require", () => {
    const result = parseLLMTemperature("1");
    expect(result.value).toBe(1);
    expect(result.valid).toBe(true);
  });

  it("accepts zero as a real value, not a fallback", () => {
    const result = parseLLMTemperature("0");
    expect(result.value).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("parses a float string", () => {
    const result = parseLLMTemperature("0.7");
    expect(result.value).toBe(0.7);
    expect(result.valid).toBe(true);
  });

  it("accepts the OpenAI-compatible upper bound", () => {
    const result = parseLLMTemperature("2");
    expect(result.value).toBe(2);
    expect(result.valid).toBe(true);
  });

  it("falls back above the upper bound", () => {
    const result = parseLLMTemperature("2.5");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });

  it("falls back for negative values", () => {
    const result = parseLLMTemperature("-1");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });

  it("falls back for NaN string", () => {
    const result = parseLLMTemperature("hot");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });
});

describe("parseLLMMaxAttempts", () => {
  it("returns undefined for empty input so the constructor default applies", () => {
    const result = parseLLMMaxAttempts("");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("returns undefined for whitespace-only input", () => {
    const result = parseLLMMaxAttempts("   ");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("accepts an explicit count", () => {
    const result = parseLLMMaxAttempts("5");
    expect(result.value).toBe(5);
    expect(result.valid).toBe(true);
  });

  it("respects 1 instead of treating it as unset", () => {
    // Regression guard: a truthiness check ("if (!maxAttempts)") would silently
    // turn "disable retries" into the built-in default of 3.
    const result = parseLLMMaxAttempts("1");
    expect(result.value).toBe(1);
    expect(result.valid).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = parseLLMMaxAttempts(" 4 ");
    expect(result.value).toBe(4);
    expect(result.valid).toBe(true);
  });

  it("accepts both bounds", () => {
    expect(parseLLMMaxAttempts(String(MIN_LLM_COMPLETION_ATTEMPTS)).value).toBe(
      MIN_LLM_COMPLETION_ATTEMPTS
    );
    expect(parseLLMMaxAttempts(String(MAX_LLM_COMPLETION_ATTEMPTS)).value).toBe(
      MAX_LLM_COMPLETION_ATTEMPTS
    );
  });

  it("rejects 0 (below the minimum)", () => {
    const result = parseLLMMaxAttempts("0");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("rejects negatives", () => {
    const result = parseLLMMaxAttempts("-2");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("rejects values above the ceiling", () => {
    const result = parseLLMMaxAttempts(String(MAX_LLM_COMPLETION_ATTEMPTS + 1));
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("rejects fractional counts instead of flooring them", () => {
    const result = parseLLMMaxAttempts("2.5");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    const result = parseLLMMaxAttempts("three");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("rejects Infinity", () => {
    const result = parseLLMMaxAttempts("Infinity");
    expect(result.value).toBeUndefined();
    expect(result.valid).toBe(false);
  });
});

/**
 * R947：`parseStrictNumber` 是本轮新增的**共用**严格解析器。
 *
 * 它替代两处坏解析：
 *   `parseInt`：把拼写错误静默变成合法但完全不同的数（"1e3"→1、"0x10"→0）
 *   `Number` ：会「照猜的读」（"0x10"→16、"1e3"→1000），对 timeout 就是
 *              1000 **毫秒**，每次审查必然超时失败而日志看不出异常
 */
describe("parseStrictNumber", () => {
  it("接受纯十进制（含一位小数，因为 timeout 5000.5ms 已被既存测试钉住）", () => {
    for (const good of ["0", "7", "600000", "5000.5", " 7 ", "007"]) {
      expect(parseStrictNumber(good).valid).toBe(true);
    }
    expect(parseStrictNumber("5000.5").value).toBe(5000.5);
  });

  it("拒绝一切非十进制写法，而不是猜一个值", () => {
    for (const bad of ["1e3", "0x10", "0b11", "0o17", "1_000", "1e-400", "+4", "-3",
      "15abc", "7px", "1.2.3", ".5", "1.", "0x", "١٢٣"]) {
      expect({ bad, valid: parseStrictNumber(bad).valid }).toEqual({ bad, valid: false });
    }
  });

  it("空串与纯空白被拒绝，绝不变成 0", () => {
    // Number("") === 0 且 Number("   ") === 0。这是整个改动最危险的一步：
    // 不拦的话「未设置」会被悄悄变成「显式 0」。
    expect(parseStrictNumber("").valid).toBe(false);
    expect(parseStrictNumber("   ").valid).toBe(false);
  });
});

describe("parseLLMTimeout 不再被非十进制写法坑到（R947）", () => {
  it.each(["1e3", "0x10", "0b11", "1_000"])("%j 被拒绝并回落默认", (bad) => {
    const r = parseLLMTimeout(bad);
    // 改前：Number("1e3")=1000 → 1000ms 每次审查必然超时；Number("0x10")=16 → 16ms
    expect(r).toEqual({ value: undefined, valid: false });
  });

  it("合法十进制仍原样通过（含小数，既有行为不变）", () => {
    expect(parseLLMTimeout("300000")).toEqual({ value: 300000, valid: true });
    expect(parseLLMTimeout("5000.5")).toEqual({ value: 5000.5, valid: true });
  });
});

describe("main.ts 接线：严格解析真的用上了，且失败会告警（R947）", () => {
  const src = readFileSync(join(__dirname, "main.ts"), "utf8");
  // 剥注释：本轮新增的注释里必然出现 parseInt / Number 这些词，不剥会自欺。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("max-output-tokens 不再用 parseInt（第三例：1e3→1 会把模型限到 1 个 token）", () => {
    const slice = code.slice(
      code.indexOf("maxOutputTokensInput"),
      code.indexOf("maxOutputTokensInput") + 700,
    );
    expect(slice).not.toMatch(/parseInt\s*\(\s*maxOutputTokensInput/);
    expect(slice).toContain("parseStrictNumber(maxOutputTokensInput)");
    // 必须判整数 + > 0，否则 1 仍会通过 llm-client 的 `> 0` 守卫
    expect(slice).toContain("Number.isInteger");
  });

  it.each([
    ["max-comments", "maxCommentsValid", "DEFAULT_MAX_COMMENTS"],
    ["max-diff-size", "maxDiffSizeValid", "DEFAULT_ACTION_MAX_DIFF_SIZE"],
  ])("%s 的 valid 标志被真的用来告警（不是解构了却不用）", (knob, flag, dflt) => {
    // 匹配**属性值**形态：必须出现 `if (!<flag>) {` 紧跟 core.warning，
    // 只搜 flag 名字会被解构处骗过（R944 M17 的教训）。
    const fn = knob === "max-comments" ? "resolveMaxComments" : "resolveMaxDiffSize";
    const callAt = code.indexOf(`${fn}(`);
    expect(callAt).toBeGreaterThan(-1);
    // 切片必须从**解构语句**开始，而不是从函数名开始：被解构出来的
    // `valid: <flag>` 出现在调用 token **之前**。只从函数名切，slice 里压根
    // 看不到它 —— 这是同一轮踩到的第二个「先判读哪一侧错了」。
    const stmtStart = code.lastIndexOf("const {", callAt);
    expect(stmtStart).toBeGreaterThan(-1);
    const slice = code.slice(stmtStart, callAt + 600);
    expect(slice).toContain(`valid: ${flag}`);
    expect(slice).toMatch(new RegExp(`if \\(!${flag}\\) \\{\\s*core\\.warning\\(`));
    expect(slice).toContain(dflt);
  });

  it("max-output-tokens 的告警文案里带上被拒的原始输入", () => {
    // 告警必须能让人看出自己写错了什么，否则等于没告警。
    expect(code).toContain("Invalid max-output-tokens value");
  });
});

/**
 * R1071：三个数字解析函数必须共用同一套写法判据。
 *
 * `parseStrictNumber` 上方的注释把这个文件的风险讲得很清楚：`Number` 会
 * 「照猜的读」，`parseInt` 更糟 —— 拼写错误被静默变成一个**合法但完全不同**的数。
 * 但 `parseLLMTemperature` 和 `parseLLMMaxAttempts` 当时各自写了裸 `Number(trimmed)`，
 * 于是教条只在一个函数里生效。实测漏判（全部 valid:true，main.ts 只在 !valid 时告警）：
 *
 *   parseLLMMaxAttempts("1e1")  → 10    ← 单次尝试静默变成 10 次，出口压力 ×10
 *   parseLLMMaxAttempts("0x3")  → 3
 *   parseLLMMaxAttempts("0b11") → 3
 *   parseLLMTemperature("0x2")  → 2     ← 十六进制把温度顶到 MAX，静默
 *   parseLLMTemperature("1e-400") → 0   ← 下溢成 0，与默认 0.1 行为不同却无异常
 *
 * 危害的性质值得说清：这些不是「解析失败」，而是**解析成功但值错了**。
 * 失败会触发 core.warning 并退回默认；成功则一路静默生效，日志里一个异常都没有。
 * 「未配置」与「拼错的配置」在这里代价特别不一样。
 */
describe("R1071：数字写法判据全局一致，非十进制写法一律拒绝", () => {
  /** 只取「非纯十进制写法」，与各函数的取值范围无关 —— 三个函数都必须拒。 */
  const nonDecimalSpellings: Array<[string, string]> = [
    ["十六进制", "0x1"],
    ["十六进制（恰在温度上限）", "0x2"],
    ["十六进制（两位）", "0x10"],
    ["二进制", "0b11"],
    ["科学计数法（放大到尝试上限）", "1e1"],
    ["科学计数法（放大三位）", "1e3"],
    ["科学计数法（写成 2）", "2e0"],
    ["科学计数法下溢", "1e-400"],
    ["显式正号", "+1"],
    ["尾随小数点", "1."],
  ];

  it.each(nonDecimalSpellings)("%s：三个函数必须一致判为非法", (_name, spelling) => {
    expect(parseStrictNumber(spelling).valid).toBe(false);
    expect(parseLLMTemperature(spelling).valid).toBe(false);
    expect(parseLLMMaxAttempts(spelling).valid).toBe(false);
  });

  it("温度不得被十六进制静默顶到上限", () => {
    // 单独钉住后果：MAX 是合法值，若解析器放过 "0x2"，
    // 调用方拿到的是一个「合法但完全不是用户所写」的温度。
    const result = parseLLMTemperature("0x2");
    expect(result.valid).toBe(false);
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.value).not.toBe(MAX_LLM_TEMPERATURE);
  });

  it("尝试次数不得被科学计数法静默放大到上限", () => {
    // 单独钉住后果：undefined + valid:false 才是对的 —— 前者让 LLMClient 构造
    // 默认值接手，后者让 main.ts 打出告警。返回 10 会把单次尝试变成十次。
    const result = parseLLMMaxAttempts("1e1");
    expect(result.valid).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it("合法的纯十进制写法不受影响", () => {
    // 防「为了修拼写错误而把正常值也拒了」。这组是三个函数各自的正常路径，
    // 范围不同的按各自范围取边界值。
    expect(parseLLMTemperature("0")).toEqual({ value: 0, valid: true });
    expect(parseLLMTemperature("1")).toEqual({ value: 1, valid: true });
    expect(parseLLMTemperature("0.7")).toEqual({ value: 0.7, valid: true });
    expect(parseLLMTemperature(String(MAX_LLM_TEMPERATURE))).toEqual({
      value: MAX_LLM_TEMPERATURE,
      valid: true,
    });

    expect(parseLLMMaxAttempts("1")).toEqual({ value: 1, valid: true });
    expect(parseLLMMaxAttempts(" 4 ")).toEqual({ value: 4, valid: true });
    expect(parseLLMMaxAttempts(String(MIN_LLM_COMPLETION_ATTEMPTS))).toEqual({
      value: MIN_LLM_COMPLETION_ATTEMPTS,
      valid: true,
    });
    expect(parseLLMMaxAttempts(String(MAX_LLM_COMPLETION_ATTEMPTS))).toEqual({
      value: MAX_LLM_COMPLETION_ATTEMPTS,
      valid: true,
    });

    // 「未配置」必须仍然是 valid:true + undefined，否则会多出一条无谓告警，
    // 并且把 getLlmCompletionAttemptCount 的 OpenRouter 免费模型例外抹掉。
    expect(parseLLMMaxAttempts("")).toEqual({ value: undefined, valid: true });
    expect(parseLLMMaxAttempts("   ")).toEqual({ value: undefined, valid: true });
    expect(parseLLMTemperature("")).toEqual({ value: DEFAULT_LLM_TEMPERATURE, valid: true });
    expect(parseLLMTemperature("  ")).toEqual({ value: DEFAULT_LLM_TEMPERATURE, valid: true });
  });

  it("小数次数仍然被整数检查拒掉（不得因改用 parseStrictNumber 而放松）", () => {
    // parseStrictNumber 允许小数，attempts 的整数检查是它自己那一层的责任。
    // 少了这层，"2.5" 就会被当成合法配置。
    const result = parseLLMMaxAttempts("2.5");
    expect(result.valid).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it("源码里这两个函数不再各自裸用 Number(trimmed)", () => {
    // 行为测试是主防线；这条只补一句「别再退化回去」。
    // R944 M17 的教训是搜标识符 ≠ 钉住接线，所以这里只钉最窄的一件事：
    // 裸 Number 的判据不许重新长回来。真正的接线由上面的行为表守住。
    const src = readFileSync(join(__dirname, "config.ts"), "utf8");
    for (const fn of ["parseLLMTemperature", "parseLLMMaxAttempts"]) {
      const start = src.indexOf(`export function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("\n}", start));
      expect(body).not.toMatch(/Number\(trimmed\)/);
      expect(body).toContain("parseStrictNumber(input)");
    }
  });
});
