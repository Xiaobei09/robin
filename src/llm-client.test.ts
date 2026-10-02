jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { LLMClient } from "./llm-client";
import { isTransientEgressFailure } from "./llm-retry";

const warningMock = core.warning as unknown as jest.Mock;

interface StubbedOpenAI {
  chat: { completions: { create: jest.Mock } };
}

function buildRequest(client: LLMClient, jsonResponseMode = true) {
  return (
    client as unknown as {
      buildRequest(
        systemPrompt: string,
        userContent: string,
        jsonResponseMode: boolean,
      ): Record<string, unknown>;
    }
  ).buildRequest("system", "user", jsonResponseMode);
}

function stubOpenAI(client: LLMClient): jest.Mock {
  const create = jest.fn();
  (client as unknown as { client: StubbedOpenAI }).client = {
    chat: { completions: { create } },
  };
  return create;
}

function completionResponse(content: string) {
  return {
    model: "resolved-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
  };
}

function reasoningRejection(
  status = 400,
  message = "Unsupported parameter: reasoning is not supported with this model",
) {
  return Object.assign(new Error(message), { status });
}

function streamOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function fallbackWarnings(): unknown[][] {
  return warningMock.mock.calls.filter(([message]) =>
    String(message).includes("Retrying once without the reasoning"),
  );
}

describe("LLMClient reasoning request shape", () => {
  it("preserves the default request shape when effort is unset", () => {
    const client = new LLMClient("https://example.test/v1", "test-key", "model");
    const request = buildRequest(client);

    expect(request).not.toHaveProperty("reasoning");
    expect(request).toMatchObject({
      model: "model",
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
    expect(request).not.toHaveProperty("max_tokens");
  });

  it.each(["", "   "])("does not emit reasoning for whitespace effort %j", (effort) => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      effort,
    );
    expect(buildRequest(client)).not.toHaveProperty("reasoning");
  });

  it("adds trimmed effort with hidden reasoning excluded", () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "  high  ",
    );
    expect(buildRequest(client).reasoning).toEqual({ effort: "high", exclude: true });
  });

  it("passes provider-specific effort names through unchanged", () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "provider-custom",
    );
    expect(buildRequest(client).reasoning).toEqual({
      effort: "provider-custom",
      exclude: true,
    });
  });
});

describe("LLMClient reasoning fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retries once without reasoning when the provider rejects the parameter", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection())
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("unsupported");
  });

  it("keeps reasoning off for later completions after one fallback", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(completionResponse("first"))
      .mockResolvedValueOnce(completionResponse("second"));

    await client.chatCompletion("system", "user");
    await client.chatCompletion("system", "user");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("does not fall back on auth errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("does not fall back on unrelated 400 validation errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("Invalid temperature: only 1 is allowed"), { status: 400 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("retries without reasoning when the configured effort is invalid", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "extreme",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("reasoning effort must be one of low, medium, high"), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "extreme", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("invalid-value");
  });

  it("retries without reasoning when a value rejection repeats the configured value", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "extreme",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        reasoningRejection(400, "reasoning effort 'extreme' is not supported by this model"),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("invalid-value");
  });

  it("falls back when the provider rejects the exclude sub-key", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(400, "Unsupported parameter: exclude"))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("propagates the error when the fallback retry also rejects", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(reasoningRejection());

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("keeps reasoning off for the outer retry after a failed fallback", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      2,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection())
      .mockRejectedValueOnce(Object.assign(new Error("backend unavailable"), { status: 500 }))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("does not fall back on server errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(Object.assign(new Error("reasoning backend failed"), { status: 500 }));

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("does not fall back when no effort was configured", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(reasoningRejection());

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("falls back for a rejected reasoning parameter on the streaming router path", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "streamed review" } }] },
        ]),
      );

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("streamed review");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("logs the provider message for plain-object rejections", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce({
        status: 400,
        message: "Unsupported parameter: reasoning is not supported",
      })
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    const warnings = fallbackWarnings();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain("Unsupported parameter: reasoning is not supported");
    expect(String(warnings[0][0])).not.toContain("[object Object]");
  });

  it("falls back when reasoning controls are explicitly rejected on the streaming path", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("reasoning controls rejected by the selected provider"), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "streamed review" } }] },
        ]),
      );

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("streamed review");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("surfaces an unrelated validation error that mentions reasoning context", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("temperature must be 1 for reasoning models"), { status: 400 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "temperature must be 1 for reasoning models",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("keeps the stall retry path after a fallback when a reasoning-flavored 400 arrives", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "first review" } }] },
        ]),
      )
      .mockRejectedValueOnce(reasoningRejection());

    await client.chatCompletion("system", "user");
    await expect(client.chatCompletion("system", "user")).rejects.toThrow("OpenRouter stall");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });
});

// 重试耗尽后抛出的那个包装错误，是「换出口」能不能工作的**唯一**输入。
// 变异验证 M2（删掉 `{ cause: lastError }`）若无本组断言则完全逃逸：
// errorTextChain 只走 message、不看 .status/.code，而包装 message 里
// 又已经把 lastError 的文本插值进去了，所以文本永远不丢 —— 真正丢掉的是
// **status**。于是选一个「正文毫无特征词、只有 status 能认出」的形态来钉。
describe("LLMClient exhausted-retry error keeps the provider cause (R925)", () => {
  function exhaustedClient() {
    return new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      2,
      undefined,
      undefined,
      undefined,
    );
  }

  async function captureCompletionError(client: LLMClient): Promise<unknown> {
    try {
      await client.chatCompletion("system", "user");
    } catch (error) {
      return error;
    }
    throw new Error("expected chatCompletion to reject");
  }

  it("exposes the last provider error as `cause`", async () => {
    const client = exhaustedClient();
    const create = stubOpenAI(client);
    const providerError = Object.assign(new Error("upstream exploded"), { status: 503 });
    // 混合形态：第 1 次报错，第 2 次（末次）返回空正文。
    // 这是 `:164` 唯一可达的路径 —— 末次 attempt 一旦抛错，`:143` 就先抛了，
    // 根本走不到耗尽分支（见 R926 笔记）。
    create.mockRejectedValueOnce(providerError).mockResolvedValueOnce(completionResponse(""));

    const wrapper = (await captureCompletionError(client)) as Error & { cause?: unknown };
    expect(wrapper.message).toContain("after 2 attempts");
    expect(wrapper.cause).toBe(providerError);
  }, 20000);

  it("stays triageable: a status-only 503 is still recognised as a transient egress failure", async () => {
    const client = exhaustedClient();
    const create = stubOpenAI(client);
    // 正文里没有任何可重试特征词（无 timeout / network / rate limit / fetch failed…），
    // 唯一的信号是 status=503。cause 断掉 ⇒ llmErrorStatus 读不到 503 ⇒
    // 分类器把一次典型的出口瞬断判成「不可重试、也不该换 CI」。
    create
      .mockRejectedValueOnce(Object.assign(new Error("upstream exploded"), { status: 503 }))
      .mockResolvedValueOnce(completionResponse(""));

    expect(isTransientEgressFailure(await captureCompletionError(client), { model: "model" })).toBe(
      true,
    );
  }, 20000);

  it("does not relaunch a permanent failure that merely got wrapped", async () => {
    const client = exhaustedClient();
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("getaddrinfo ENOTFOUND api.invalid.test"), { code: "ENOTFOUND" }),
      )
      .mockResolvedValueOnce(completionResponse(""));

    // 反向钉子：包装不该把永久性故障洗成瞬时，否则配错域名会无限重启 CI。
    expect(
      isTransientEgressFailure(await captureCompletionError(client), { model: "model" }),
    ).toBe(false);
  }, 20000);
});
