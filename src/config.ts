export const DEFAULT_LLM_TIMEOUT_MS = 600000; // 10 minutes
export const DEFAULT_LLM_ROUTER_TIMEOUT_MS = 120000; // 2 minutes — openrouter/free happy path is ~60-90s
export const DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS = 45000; // no SSE = stacked router; fail fast and retry
export const DEFAULT_LLM_COMPLETION_ATTEMPTS = 3;
export const DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS = 5;
export const DEFAULT_LLM_RETRY_DELAY_MS = 2000;
export const DEFAULT_LLM_ROUTER_RETRY_DELAY_MS = 3000;
export const DEFAULT_LLM_TEMPERATURE = 0.1; // near-deterministic reviews
/** OpenAI-compatible upper bound; some models (e.g. Kimi) only accept 1. */
export const MAX_LLM_TEMPERATURE = 2;

/**
 * 严格数字解析：只接受**纯十进制写法**（可选一位小数部分）。
 *
 * 为什么不直接用 `Number()`：`Number` 会「照猜的读」而不是拒绝拼写错误 ——
 * `Number("0x10")=16`、`Number("0b11")=3`、`Number("1e3")=1000`。对 timeout 这种
 * 参数，那意味着 `llm-timeout-ms: 1e3` 变成 1000 **毫秒**，每次审查必然超时失败，
 * 而日志里看不出任何异常。`parseInt` 更糟：它把拼写错误**静默变成一个合法但完全
 * 不同的数**（`parseInt("1e3")=1`、`parseInt("0x10")=0`）。
 *
 * 空串必须先拦：`Number("") === 0`。不拦的话「未设置」会被悄悄变成「显式 0」。
 * 下溢同理：`Number("1e-400") === 0`。
 *
 * 小数**允许**（timeout 5000.5ms 虽无意义但无害，且已有测试钉住），
 * 需要整数的调用方自己加 `Number.isInteger`。
 */
export function parseStrictNumber(input: string): { value: number; valid: boolean } {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { value: Number.NaN, valid: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { value: Number.NaN, valid: false };
  return { value: parsed, valid: true };
}

/**
 * 解析 `llm-timeout-ms`。
 *
 * **`undefined` 表示「未配置」，与任何具体数字都不同。** 这一层必须保留这个区分，
 * 否则下游 `resolveLlmTimeoutMs` 只能拿「值是否等于 `DEFAULT_LLM_TIMEOUT_MS`」
 * 去猜用户有没有配过 —— 而用户显式写 `600000`（与默认值同数）就会被误判成没配，
 * 对 OpenRouter 路由模型静默降级成 120000ms，推理模型慢的 PR 必然超时。
 *
 * 与 `parseLLMMaxAttempts` 同一套制度（那边把「未配置」留给构造默认值 +
 * OpenRouter 例外接手），也是 `action.yml` 里 `default: ""` 的原因。
 */
export function parseLLMTimeout(input: string): { value: number | undefined; valid: boolean } {
  if (!input) return { value: undefined, valid: true };
  const { value: parsed, valid } = parseStrictNumber(input);
  if (valid && parsed > 0) {
    return { value: parsed, valid: true };
  }
  return { value: undefined, valid: false };
}

export function parseLLMTemperature(input: string): { value: number; valid: boolean } {
  const trimmed = input.trim();
  if (!trimmed) return { value: DEFAULT_LLM_TEMPERATURE, valid: true };
  // 走 parseStrictNumber，而不是裸 `Number()` —— 理由见该函数上方注释：
  // `Number` 会照猜的读，把拼写错误变成一个合法但完全不同的数。
  // 具体到温度，漏判的后果实测如下（都是 valid:true，日志一句警告都不会有）：
  //   "0x2"    → 2   ← 十六进制字面量，静默把温度顶到 MAX_LLM_TEMPERATURE
  //   "1e-400" → 0   ← 下溢成 0，与默认的 0.1 行为不同却看不出任何异常
  //   "+1" / "1." → 1 ← 带符号 / 尾点写法同样被"猜"出来
  // 温度直接决定采样多样性，静默落到上限 2 是最难察觉的一类配置漂移。
  const { value: parsed, valid } = parseStrictNumber(input);
  // 0 is a legitimate value, so range-check instead of truthiness.
  if (valid && parsed >= 0 && parsed <= MAX_LLM_TEMPERATURE) {
    return { value: parsed, valid: true };
  }
  return { value: DEFAULT_LLM_TEMPERATURE, valid: false };
}

/** Bounds for the optional `llm-max-attempts` input.
 *  1 disables LLM retries entirely; the ceiling stops a mistyped workflow from
 *  hammering the provider for the whole job budget. */
export const MIN_LLM_COMPLETION_ATTEMPTS = 1;
export const MAX_LLM_COMPLETION_ATTEMPTS = 10;

/**
 * Parse the optional `llm-max-attempts` action input.
 *
 * `value: undefined` means "not configured" and is deliberately distinct from a
 * number: passing it through to `LLMClient` keeps the constructor default
 * (`DEFAULT_LLM_COMPLETION_ATTEMPTS`), which in turn keeps
 * `getLlmCompletionAttemptCount`'s OpenRouter exception (5 attempts for
 * `openrouter/…/free` models) intact. Returning a concrete fallback number here
 * would silently disable that exception, so an unparseable input yields
 * `undefined` + `valid:false` and the caller only warns.
 */
export function parseLLMMaxAttempts(input: string): { value: number | undefined; valid: boolean } {
  const trimmed = input.trim();
  if (!trimmed) return { value: undefined, valid: true };
  // 同样走 parseStrictNumber。这一处的漏判后果比温度更实在：
  //   "1e1" → 10   ← 科学计数法静默变成「上限 10 次尝试」，放大 10 倍的出口压力
  //   "0x3" → 3    "0b11" → 3    "2e0" → 2
  // 全部 valid:true，调用方（main.ts）只在 !valid 时告警 ⇒ 一声不吭地生效。
  // 「未配置」与「拼错的配置」在这里代价特别不一样：拼错 ⇒ 反复打 provider。
  const { value: parsed, valid } = parseStrictNumber(input);
  // Integer check: "2.5" attempts is meaningless, and Math.floor would hide a typo.
  if (
    valid &&
    Number.isInteger(parsed) &&
    parsed >= MIN_LLM_COMPLETION_ATTEMPTS &&
    parsed <= MAX_LLM_COMPLETION_ATTEMPTS
  ) {
    return { value: parsed, valid: true };
  }
  return { value: undefined, valid: false };
}
