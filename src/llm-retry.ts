import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";

export interface LlmRetryContext {
  model?: string;
}

/** OpenRouter routers (e.g. openrouter/free) pick models dynamically — no secret updates needed. */
export function resolveLlmTimeoutMs(model: string | undefined, timeoutMs: number): number {
  if (timeoutMs !== DEFAULT_LLM_TIMEOUT_MS) return timeoutMs;
  return isOpenRouterRouterModel(model) ? DEFAULT_LLM_ROUTER_TIMEOUT_MS : timeoutMs;
}

export function isOpenRouterRouterModel(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  return (
    normalized === "openrouter/free" ||
    normalized === "openrouter/auto" ||
    normalized.startsWith("openrouter/") && normalized.endsWith("/free")
  );
}

export function isOpenRouterProviderError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("provider returned error");
}

/**
 * 人类可读的错误摘要。
 *
 * 三件事在这里收口，因为它们都直接影响「维护者能不能自查」：
 *
 * 1. **空 message 必须兜底。** 生产实证（SiliconMod/Silicon#67，run 36585231278）：
 *    一条 `Reason: ` 后面什么都没有的失败评论。`new Error("")` 的 message 是空串，
 *    `instanceof Error` 分支会把它原样返回，于是评论里那行等于不存在 ——
 *    而这恰恰是最需要解释的一次失败。
 *
 * 2. **优先取 `response.data.message`。** octokit 的 `RequestError.message` 只有
 *    `Request failed due to error response: 403` 这种壳，真正的原因在
 *    `response.data.message`（例如 `Resource not accessible by integration`，
 *    正是 fork PR token 被降级成只读时的那个）。不取的话日志只能看到状态码，
 *    而「为什么是 403」这个唯一有用的信息被丢掉了。
 *
 * 3. **body 里可能夹带凭据。** `response.data` 在 OAuth 错误等分支里会带
 *    `client_secret` / `access_token`。这里**只取白名单字段**，绝不整体序列化
 *    response —— 这些文本会进 PR 评论（公开），而评论那行还写着
 *    "No secrets are included in this message"。
 *
 * 输出单行：换行会被 markdown 折行渲染成多行，破坏 `Reason: ` 那一行的可读性。
 */
export function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);

  const detail = extractResponseDetail(error);
  const combined = [raw, detail].filter((part) => part && part.trim()).join(": ");
  // 单行化：评论正文里换行会让 `Reason: ` 那一行读起来断掉。
  const single = combined.replace(/\s+/g, " ").trim();
  if (single) return truncate(single, MAX_ERROR_MESSAGE_CHARS);

  // 兜底：宁可给一个明确无信息量的占位，也不要留空 —— 空的那行会让
  // 这次失败看起来像「Robin 什么都没做就挂了」。
  const name = error instanceof Error ? error.name : undefined;
  return name && name !== "Error"
    ? `${name} (no message)`
    : "unknown error (no message)";
}

/** 上限：评论正文不是日志，超长原文没有阅读价值，还会把评论撑得很难看。 */
const MAX_ERROR_MESSAGE_CHARS = 400;

/**
 * 从 HTTP 错误里取出**白名单**的诊断字段。
 *
 * 刻意只认这几个 key：它们是 GitHub 错误体的固定结构，且不含凭据。
 * 整个 `response.data` 绝不能被序列化进 PR 评论。
 */
function extractResponseDetail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["message", "error_description", "documentation_url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Explicit parameter rejections that name the extra parameter. These win over the value
 * bail-outs so an explicit rejection is not masked by an incidental value word later in
 * the message (for example a provider that echoes the configured value while rejecting
 * the parameter itself).
 */
const EXPLICIT_UNSUPPORTED_PARAMETER_PHRASES: RegExp[] = [
  // The parameter noun must follow the adjective directly: "Unsupported value for parameter
  // reasoning" is a value complaint, while "Unsupported parameter: reasoning" is not. The gap
  // can cross a colon that introduces the field name, but not a comma or clause-ending
  // punctuation, so an unrelated parameter named before a separate "reasoning" clause
  // does not match.
  /\b(?:unsupported|unknown|unrecognized|unrecognised)\s+(?:parameter|argument|field|property|option|input|feature)\b[^.;!?,]{0,40}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  /\b(?:does|do|did)\s+not\s+support\b[^.;!?]{0,30}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  // The parameter itself is the subject: a value echo later in the message is incidental.
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)\s+(?:is|are|was|were)\s+(?:not\s+supported|unsupported)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b\s+(?:is|are|was|were)\s+not\s+one\s+of\s+(?:the\s+)?(?:supported|allowed|known|recognized|recognised)\s+(?:parameters?|arguments?|fields?|properties|options?|inputs?|features?)\b/i,
  /\b(?:reasoning(?:[_-]?(?:effort|exclude))?|reasoning\s+(?:controls?|parameters?|fields?)|effort|exclude)\b\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:rejected|refused)\b/i,
];

/** Provider phrases meaning the extra parameter itself is unknown, not that its value is bad. */
const UNSUPPORTED_PARAMETER_PHRASES: RegExp[] = [
  /(?:unsupported|unknown|unrecognized|unrecognised|unexpected)(?:\s+\w+){0,2}\s+(?:parameter|argument|field|property|option|input|feature)\b[^.;!?,]{0,30}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  /\bunknown\s+name\b/i,
  /\bcannot\s+(?:bind|find)\s+(?:the\s+)?(?:field|property|parameter)\b/i,
  /(?:parameter|argument|field|property|option|input|feature)\b[^.!?]{0,40}\b(?:unsupported|unknown|unrecognized|unrecognised|unexpected)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)(?:\s+\w+){0,3}\s+(?:is|are|was|were)\s+(?:not\s+supported|unsupported)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)(?:\s+\w+){0,3}\s+(?:(?:is|are|was|were)\s+)?not\s+supported\s+(?:by|for|with|in|on)\b/i,
  /\b(?:parameter|argument|field|property|option|feature)\b[^.!?]{0,30}\b(?:is|are|was|were)\s+not\s+(?:allowed|permitted|recognized|recognised)\b/i,
  /\bextra\s+(?:inputs?|fields?|properties|arguments?|parameters?)\b/i,
];

/** Schema/shape complaints about the reasoning field itself, not about its configured value. */
const SHAPE_MISMATCH_PHRASES: RegExp[] = [
  /\binput should be (?:a|an)\s+(?:valid\s+)?(?:string|object|boolean|number|array)\b/i,
];

/** Malformed-value signals: these must keep failing rather than mask a configuration typo. */
const INVALID_VALUE_PHRASES: RegExp[] = [
  /\binvalid\s+(?:value|type|format)\b/i,
  /\b(?:must|should|needs?\s+to)\s+be\s+(?:one\s+of|between|greater|less|at\s+most|at\s+least|a|an)\b/i,
  /\b(?:expected|not)\s+one\s+of\b/i,
  /\bout\s+of\s+range\b/i,
  /\b(?:valid|allowed)\s+values?\s+(?:are|is)\b/i,
  /\bnot\s+a\s+valid\b/i,
];

/**
 * True only for a client validation response (400/422) that reports the reasoning
 * configuration itself as unknown, unsupported, or of the wrong shape — the cases where
 * dropping the reasoning parameter and retrying is safe. Explicit parameter rejections and
 * a structured `param` naming the reasoning field win over the value bail-outs; invalid
 * effort values, missing values, and generic validation errors must surface normally.
 */
export function isUnsupportedReasoningEffortError(error: unknown, sentEffort?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return false;
  const message = errorMessage(error);

  if (EXPLICIT_UNSUPPORTED_PARAMETER_PHRASES.some((pattern) => pattern.test(message))) {
    return true;
  }

  const mentionsReasoning = /\b(?:reasoning|effort|exclude)/i.test(message);
  if (mentionsReasoning && sentEffort && mentionsEffortValue(message, sentEffort)) return false;
  if (mentionsReasoning && SHAPE_MISMATCH_PHRASES.some((pattern) => pattern.test(message))) {
    return true;
  }
  // Value complaints must win over a structured param: a param-only invalid-value message
  // may not mention the key at all.
  if (INVALID_VALUE_PHRASES.some((pattern) => pattern.test(message))) {
    return false;
  }
  if (structuredReasoningParam(error)) return true;
  if (!mentionsReasoning) return false;
  return UNSUPPORTED_PARAMETER_PHRASES.some((pattern) => pattern.test(message));
}

/**
 * True only when a 400/422 response clearly rejects the configured reasoning-effort
 * value. These errors are safe to recover from by omitting the optional reasoning object,
 * while unrelated validation failures must still surface normally.
 */
export function isInvalidReasoningEffortError(error: unknown, sentEffort?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return false;
  if (isUnsupportedReasoningEffortError(error, sentEffort)) return false;

  const message = errorMessage(error);
  const mentionsReasoning = /\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i.test(message);
  if (!mentionsReasoning && !structuredReasoningParam(error)) return false;

  if (INVALID_VALUE_PHRASES.some((pattern) => pattern.test(message))) return true;

  // Some providers describe a model-specific value rejection as "not supported" and
  // echo the submitted value instead of listing the accepted values.
  return Boolean(
    sentEffort &&
      mentionsEffortValue(message, sentEffort) &&
      /\b(?:invalid|unsupported|not\s+(?:supported|allowed|recognized|recognised))\b/i.test(message)
  );
}

/** Word-boundary match so short values like `low` or `max` cannot hit `follow` or `maximum`. */
function mentionsEffortValue(message: string, effort: string): boolean {
  const escaped = effort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, "i").test(message);
}

/** OpenAI-compatible SDK errors may name the offending parameter structurally. */
function structuredReasoningParam(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const param = (error as { param?: unknown }).param;
  return typeof param === "string" && /\b(?:reasoning|effort|exclude)/i.test(param);
}

const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * 把错误自身与整条 `cause` 链拼成一段小写文本。
 *
 * 为什么需要：Node/undici 把绝大多数出口层故障（DNS 解析失败、连接被拒、
 * TLS 握手失败、socket 断连）统一报成 `TypeError: fetch failed`，真实原因
 * 只挂在 `error.cause` 上。只看 `error.message` 的话，"fetch failed"
 * 一个关键词都匹配不上 ⇒ 被判成不可重试 ⇒ 一次都不重试。
 *
 * 深度有界（5 层）且按对象身份防环，避免 cause 自引用时死循环。
 */
export function errorTextChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === "object" || typeof current === "function") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    parts.push(
      current instanceof Error ? current.message : String(current)
    );
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ").toLowerCase();
}

export function isRetriableLlmError(error: unknown, context: LlmRetryContext = {}): boolean {
  if (!error) return false;

  const routerModel = isOpenRouterRouterModel(context.model);

  // 统一走 llmErrorStatus：它会沿 cause 链找 status。早先这里内联了一份
  // 「只看顶层 status」的读取，与 isPermanentEgressFailure 各写各的，结果两边
  // 在真实调用路径（错误已被 llm-client 包装）上都读不到 provider 的状态码。
  const status = llmErrorStatus(error);
  if (status !== undefined) {
    if (status === 429 || status >= 500) {
      return true;
    }
    if (status === 404 && routerModel) {
      return true;
    }
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  const message = errorTextChain(error);
  if (routerModel && (message.includes("404") || isOpenRouterProviderError(error))) {
    return true;
  }

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("rate limit") ||
    message.includes("overloaded") ||
    message.includes("empty response from llm") ||
    message.includes("openrouter stall") ||
    // 以下是实测漏判、但确属出口层瞬时故障的形态（探针见 R899）：
    message.includes("fetch failed") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("enotfound") ||
    message.includes("econnaborted") ||
    message.includes("ehostunreach") ||
    message.includes("enetunreach") ||
    message.includes("epipe") ||
    message.includes("und_err")
  );
}

/**
 * 永久性出口故障的特征词。
 *
 * 与 `isRetriableLlmError` 刻意分开：那个谓词管「同一次 run 内还要不要再试一次」，
 * 成本只是几次 attempt，所以对「域名写错」这类错误也宽容。这个谓词管
 * 「要不要抛弃这个 CI、另起一个新 CI」—— 成本是整条流水线，绝不能被永久性配置错误
 * 触发，否则配错一次 base-url 就会变成无限重启 CI。
 */
const PERMANENT_EGRESS_KEYWORDS = [
  // DNS 明确报「主机不存在」：域名写错或该主机已下线，换几次 runner 都不会变。
  // 注意必须与瞬时的 eai_again（DNS 暂时失败）区分开，两者都是 getaddrinfo 家族。
  "enotfound",
  "und_err_invalid_url",
  "invalid_api_key",
  "incorrect api key",
  "unauthorized",
  "forbidden",
  "model_not_found",
  "unknown model",
  "no such model",
  "does not support",
];

/**
 * 这些 4xx 看着像「客户端错误」，实际却是**瞬时**的。
 *
 * 429 限流尤其关键：它是最该「换个 CI（换 IP/换 runner）重试」的典型场景，
 * 绝不能被当成「换几次都没用的配置错误」—— 那会让换出口这个功能在最需要时失灵。
 * 408 是服务端等请求等超时，同理。
 */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 429]);

/**
 * 取出错误链上的 HTTP 状态码；没有就返回 undefined（连接层错误没有 status）。
 *
 * **必须沿 cause 链往上找**。调用方（`main.ts` 的 catch）拿到的是
 * `llm-client.ts` 包装过的错误，真正的 provider 错误挂在 `cause` 上、
 * `status` 也只挂在那一层。只看顶层的话，生产路径上 `status` 恒为 undefined，
 * 下面所有按状态码分类的规则（429/408 瞬时、4xx 永久、5xx 可重试）全部是死代码 ——
 * 而单测直接喂原始错误，恰好把这个洞盖住了（R926）。
 *
 * 遍历方式与 `errorTextChain` 一致：限深 + 防环。
 */
function llmErrorStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current === "object" || typeof current === "function") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    if (typeof current === "object" && "status" in current) {
      const status = Number((current as { status?: number }).status);
      if (Number.isFinite(status)) return status;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 这个错误是否「换一个 CI run 也不会变好」。
 *
 * 命中即表示：不该拿它去触发重新跑一个 CI。
 */
export function isPermanentEgressFailure(
  error: unknown,
  context: LlmRetryContext = {},
): boolean {
  if (!error) return false;

  const routerModel = isOpenRouterRouterModel(context.model);
  const status = llmErrorStatus(error);

  if (status !== undefined && status >= 400 && status < 500) {
    if (TRANSIENT_CLIENT_STATUSES.has(status)) return false;
    // OpenRouter 路由模型报 404 是「这个后端暂时没这个模型」，路由会换后端，属瞬时。
    if (!(status === 404 && routerModel)) return true;
  }

  const message = errorTextChain(error);
  return PERMANENT_EGRESS_KEYWORDS.some((keyword) => message.includes(keyword));
}

/**
 * 出口是否处于**瞬时**故障：值得抛弃当前 CI、另起一个新 CI 继续审查。
 *
 * 必须同时满足「可重试」（确实是故障，不是配置错）与「非永久」
 * （换个 run 有机会好）。注意它与 `isRetriableLlmError` 是**两个独立决策**，
 * 后者更宽松，前者更严格。
 */
export function isTransientEgressFailure(
  error: unknown,
  context: LlmRetryContext = {},
): boolean {
  if (!isRetriableLlmError(error, context)) return false;
  return !isPermanentEgressFailure(error, context);
}

export function shouldUseJsonResponseMode(
  attempt: number,
  jsonResponseMode: boolean
): boolean {
  return jsonResponseMode && attempt === 1;
}

/**
 * 退避抖动幅度（±25%）。原先退避是纯线性的：同一批并发作业在网关抖动时
 * 会算出完全相同的等待值、同一时刻一起重试，形成惊群，反而把刚恢复的
 * 出口再打垮。抖动让重试在时间上散开。
 *
 * `random` 可注入，测试里传 `() => 0.5` 即得到无抖动的精确值。
 */
export const RETRY_JITTER_RATIO = 0.25;

export function computeRetryDelayMs(
  attempt: number,
  context: LlmRetryContext = {},
  baseDelayMs = isOpenRouterRouterModel(context.model)
    ? DEFAULT_LLM_ROUTER_RETRY_DELAY_MS
    : DEFAULT_LLM_RETRY_DELAY_MS,
  random: () => number = Math.random
): number {
  const linear = baseDelayMs * attempt;
  const spread = linear * RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(linear + (random() * 2 - 1) * spread));
}

export function getLlmCompletionAttemptCount(
  maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
  model?: string
): number {
  const resolved =
    maxAttempts === DEFAULT_LLM_COMPLETION_ATTEMPTS && isOpenRouterRouterModel(model)
      ? DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS
      : maxAttempts;
  return Math.max(1, Math.floor(resolved));
}

export async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function openRouterStallError(firstChunkMs: number): Error {
  return new Error(`OpenRouter stall: no first response within ${firstChunkMs} ms`);
}
