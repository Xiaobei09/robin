import {
  RETRY_JITTER_RATIO,
  computeRetryDelayMs,
  getLlmCompletionAttemptCount,
  isInvalidReasoningEffortError,
  isOpenRouterRouterModel,
  isRetriableLlmError,
  isUnsupportedReasoningEffortError,
  openRouterStallError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";

describe("openRouterStallError", () => {
  it("produces a retriable stall message", () => {
    const error = openRouterStallError(45000);
    expect(error.message).toContain("OpenRouter stall");
    expect(isRetriableLlmError(error, { model: "openrouter/free" })).toBe(true);
  });
});

describe("resolveLlmTimeoutMs", () => {
  it("shortens the default timeout for OpenRouter routers", () => {
    expect(resolveLlmTimeoutMs("openrouter/free", DEFAULT_LLM_TIMEOUT_MS)).toBe(
      DEFAULT_LLM_ROUTER_TIMEOUT_MS
    );
    expect(resolveLlmTimeoutMs("gpt-4o", DEFAULT_LLM_TIMEOUT_MS)).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("keeps an explicit consumer override", () => {
    expect(resolveLlmTimeoutMs("openrouter/free", 300000)).toBe(300000);
  });
});

describe("isOpenRouterRouterModel", () => {
  it("detects OpenRouter free and auto routers", () => {
    expect(isOpenRouterRouterModel("openrouter/free")).toBe(true);
    expect(isOpenRouterRouterModel("openrouter/auto")).toBe(true);
    expect(isOpenRouterRouterModel("gpt-4o")).toBe(false);
  });
});

describe("isRetriableLlmError", () => {
  it("retries rate limits and server errors", () => {
    expect(isRetriableLlmError({ status: 429 })).toBe(true);
    expect(isRetriableLlmError({ status: 502 })).toBe(true);
  });

  it("does not retry client auth or validation errors", () => {
    expect(isRetriableLlmError({ status: 401 })).toBe(false);
    expect(isRetriableLlmError({ status: 400 })).toBe(false);
  });

  it("retries network and timeout messages", () => {
    expect(isRetriableLlmError(new Error("Request timed out"))).toBe(true);
    expect(isRetriableLlmError(new Error("ECONNRESET"))).toBe(true);
    expect(
      isRetriableLlmError(new Error("OpenRouter stall: no first response within 45000 ms"), {
        model: "openrouter/free",
      })
    ).toBe(true);
  });

  it("retries OpenRouter provider 404s for router models", () => {
    expect(
      isRetriableLlmError(new Error("404 Provider returned error"), {
        model: "openrouter/free",
      })
    ).toBe(true);
    expect(isRetriableLlmError({ status: 404 }, { model: "openrouter/free" })).toBe(true);
    expect(isRetriableLlmError({ status: 404 }, { model: "gpt-4o" })).toBe(false);
  });
});

describe("isUnsupportedReasoningEffortError", () => {
  it("detects 400/422 responses that report the reasoning/effort parameter as unknown", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unsupported parameter: 'reasoning' is not supported with this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        Object.assign(new Error("reasoning_effort is not supported"), { status: 422 })
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Unknown parameter: effort" })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unrecognized request argument supplied: reasoning",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "This model does not support reasoning",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "The reasoning effort control is not supported for this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning not supported by this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "The reasoning parameter is not allowed for this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning: Extra inputs are not permitted",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: 'Unknown name "reasoning": Cannot bind field.',
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message:
          "Invalid JSON payload received. Unknown name \"reasoning\" at 'reasoning': Cannot find field.",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning: Input should be a valid string",
      })
    ).toBe(true);
  });

  it("lets an explicit parameter rejection win over value words elsewhere", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Unsupported parameter: reasoning; valid values are low, medium, high",
        },
        "low"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "This model does not support high-effort reasoning" },
        "high"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "reasoning is not supported with this model for effort high" },
        "high"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning is not one of the supported parameters",
      })
    ).toBe(true);
  });

  it("does not cross a comma from an unrelated rejected parameter", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Unsupported parameter: temperature, reasoning models require temperature 1",
        },
        "high"
      )
    ).toBe(false);
  });

  it("keeps a mixed invalid-value message on the value path", () => {
    const mixed = {
      status: 400,
      message: "Unsupported value for parameter reasoning: must be one of low, medium, high",
    };
    expect(isUnsupportedReasoningEffortError(mixed, "extreme")).toBe(false);
    expect(isUnsupportedReasoningEffortError(mixed, "low")).toBe(false);
  });

  it("keeps a structured-param value complaint on the value path", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Invalid value: 'extreme'. Supported values are: low, medium, high",
          param: "reasoning_effort",
        },
        "extreme"
      )
    ).toBe(false);
  });

  it("matches explicit parameter rejections with underscored and hyphenated names", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unsupported parameter: reasoning_effort",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning-effort is not supported",
      })
    ).toBe(true);
  });

  it("matches an explicit rejection of reasoning controls", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning controls rejected by the selected provider",
      })
    ).toBe(true);
  });

  it("uses a structured param naming the reasoning field when message text is inconclusive", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Request validation failed",
        param: "reasoning_effort",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Invalid value for 'reasoning_effort': 'extreme'",
        param: "reasoning_effort",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Request validation failed",
        param: "temperature",
      })
    ).toBe(false);
  });

  it("treats a message repeating the configured effort value as a value complaint", () => {
    const valueRejection = {
      status: 400,
      message: "reasoning effort 'extreme' is not supported by this model",
    };
    expect(isUnsupportedReasoningEffortError(valueRejection, "extreme")).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "reasoning is not supported with this model" },
        "extreme"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "Unsupported parameter: reasoning; follow the docs" },
        "low"
      )
    ).toBe(true);
  });

  it("detects a rejected exclude sub-key of the reasoning request", () => {
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Unsupported parameter: exclude" })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Invalid API key" })
    ).toBe(false);
  });

  it("ignores auth, rate-limit, server, timeout, and unrelated validation errors", () => {
    expect(
      isUnsupportedReasoningEffortError({ status: 401, message: "Invalid API key" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 429, message: "reasoning rate limit" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 500, message: "reasoning backend failed" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Invalid temperature" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "temperature 2 is not supported; reasoning models require 1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "temperature 2 is not supported for reasoning models",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning models do not support temperature 0.1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unknown parameter: temperature; reasoning models require temperature 1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "This model does not support temperature; reasoning models need 1",
      })
    ).toBe(false);
    expect(isUnsupportedReasoningEffortError(new Error("reasoning rejected"))).toBe(false);
    expect(isUnsupportedReasoningEffortError(undefined)).toBe(false);
  });

  it("does not treat invalid, out-of-range, or missing reasoning values as unsupported", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort must be one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort should be one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning_effort: invalid value; expected one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Invalid value for 'reasoning_effort': 'extreme' is not one of [low, medium, high]",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning_effort 'extreme' is not allowed; use low, medium, or high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort out of range: allowed values are low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Missing required parameter: reasoning_effort",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort is required",
      })
    ).toBe(false);
  });
});

describe("isInvalidReasoningEffortError", () => {
  it("detects clear reasoning-effort value rejections", () => {
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "reasoning effort must be one of low, medium, high" },
        "extreme"
      )
    ).toBe(true);
    expect(
      isInvalidReasoningEffortError(
        {
          status: 422,
          message: "Invalid value: 'extreme'. Supported values are low, medium, high",
          param: "reasoning_effort",
        },
        "extreme"
      )
    ).toBe(true);
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "reasoning effort 'extreme' is not supported by this model" },
        "extreme"
      )
    ).toBe(true);
  });

  it("does not mask unsupported parameters or unrelated failures", () => {
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "Unsupported parameter: reasoning" },
        "high"
      )
    ).toBe(false);
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "Invalid temperature: only 1 is allowed" },
        "high"
      )
    ).toBe(false);
    expect(
      isInvalidReasoningEffortError(
        { status: 401, message: "Invalid reasoning effort" },
        "high"
      )
    ).toBe(false);
  });
});

describe("shouldUseJsonResponseMode", () => {
  it("uses JSON only on the first attempt", () => {
    expect(shouldUseJsonResponseMode(1, true)).toBe(true);
    expect(shouldUseJsonResponseMode(2, true)).toBe(false);
    expect(shouldUseJsonResponseMode(1, false)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  // 注入 random=0.5 ⇒ 抖动项恰为 0，退避回到精确的线性值。
  const noJitter = () => 0.5;

  it("backs off linearly by attempt", () => {
    expect(computeRetryDelayMs(1, {}, 1000, noJitter)).toBe(1000);
    expect(computeRetryDelayMs(2, {}, 1000, noJitter)).toBe(2000);
  });

  it("uses longer base delay for router models", () => {
    expect(
      computeRetryDelayMs(1, { model: "openrouter/free" }, undefined, noJitter)
    ).toBe(DEFAULT_LLM_ROUTER_RETRY_DELAY_MS);
  });

  it("spreads retries in time so concurrent runs don't stampede (R900)", () => {
    // 同一 attempt 下 random 取两端 ⇒ 等待值分别落在 ±25% 的下界与上界。
    expect(computeRetryDelayMs(3, {}, 1000, () => 0)).toBe(2250);
    expect(computeRetryDelayMs(3, {}, 1000, () => 1)).toBe(3750);
    // random=0.5 时抖动项为 0，仍是线性值本身。
    expect(computeRetryDelayMs(3, {}, 1000, noJitter)).toBe(3000);
    // 抖动幅度受 RETRY_JITTER_RATIO 约束，不会把等待压到 0 或翻倍。
    for (const r of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const d = computeRetryDelayMs(4, {}, 1000, () => r);
      expect(d).toBeGreaterThanOrEqual(4000 * (1 - RETRY_JITTER_RATIO));
      expect(d).toBeLessThanOrEqual(4000 * (1 + RETRY_JITTER_RATIO));
    }
  });

  it("never returns a negative delay", () => {
    expect(computeRetryDelayMs(0, {}, 1000, () => 0)).toBe(0);
  });
});

describe("getLlmCompletionAttemptCount", () => {
  it("clamps invalid values to at least one", () => {
    expect(getLlmCompletionAttemptCount(0)).toBe(1);
    expect(getLlmCompletionAttemptCount(2.7)).toBe(2);
  });

  it("uses more attempts for OpenRouter router models by default", () => {
    expect(getLlmCompletionAttemptCount(DEFAULT_LLM_COMPLETION_ATTEMPTS, "openrouter/free")).toBe(
      DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS
    );
    expect(getLlmCompletionAttemptCount(DEFAULT_LLM_COMPLETION_ATTEMPTS, "gpt-4o")).toBe(
      DEFAULT_LLM_COMPLETION_ATTEMPTS
    );
  });
});

describe("isRetriableLlmError 的出口故障覆盖（R900）", () => {
  // 这批形态此前全部被判成"不可重试"，于是 CI 出口抖动时一次都不重试。
  const egress: Array<[string, unknown]> = [
    ["undici 通用出口失败", new TypeError("fetch failed")],
    ["DNS 解析失败（cause 挂在 cause 上）", Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.openai.com") })],
    ["DNS 临时失败", new Error("getaddrinfo EAI_AGAIN api.openai.com")],
    ["连接超时", new Error("connect ETIMEDOUT 1.2.3.4:443")],
    ["socket 被中断", Object.assign(new TypeError("fetch failed"), { cause: new Error("UND_ERR_SOCKET") })],
    ["连接被中止", new Error("read ECONNABORTED")],
    ["主机不可达", new Error("connect EHOSTUNREACH 1.2.3.4:443")],
    ["网络不可达", new Error("connect ENETUNREACH 1.2.3.4:443")],
    ["管道断开", new Error("write EPIPE")],
    ["原有的连接重置", new Error("read ECONNRESET")],
    ["原有的 socket hang up", new Error("socket hang up")],
    ["限流", Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["服务端错误", Object.assign(new Error("boom"), { status: 500 })],
  ];

  for (const [name, err] of egress) {
    it(`重试：${name}`, () => {
      expect(isRetriableLlmError(err)).toBe(true);
    });
  }

  it("仍然不重试：4xx（配置/鉴权错，重试无意义）", () => {
    expect(isRetriableLlmError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isRetriableLlmError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
    expect(isRetriableLlmError(Object.assign(new Error("forbidden"), { status: 403 }))).toBe(false);
  });

  it("cause 自引用时不死循环", () => {
    const loop: Error & { cause?: unknown } = new Error("boom");
    loop.cause = loop;
    expect(isRetriableLlmError(loop)).toBe(false);
  });

  it("cause 链超过深度上界也能终止", () => {
    let err: Error & { cause?: unknown } = new Error("socket hang up");
    for (let i = 0; i < 50; i++) {
      const next: Error & { cause?: unknown } = new Error("layer");
      next.cause = err;
      err = next;
    }
    // 最外层 5 层内都是 "layer"，够不到 socket hang up ⇒ 不可重试，但必须能返回。
    expect(isRetriableLlmError(err)).toBe(false);
    // 把有用的那层挪进深度窗口内就应当可重试。
    let shallow: Error & { cause?: unknown } = new Error("socket hang up");
    for (let i = 0; i < 3; i++) {
      const next: Error & { cause?: unknown } = new Error("layer");
      next.cause = shallow;
      shallow = next;
    }
    expect(isRetriableLlmError(shallow)).toBe(true);
  });
});
