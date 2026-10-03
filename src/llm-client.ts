import { OpenAI } from "openai";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS,
  DEFAULT_LLM_TEMPERATURE,
} from "./config";
import {
  computeRetryDelayMs,
  delayMs,
  errorMessage,
  getLlmCompletionAttemptCount,
  isInvalidReasoningEffortError,
  isOpenRouterRouterModel,
  isRetriableLlmError,
  isUnsupportedReasoningEffortError,
  openRouterStallError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import { ReasoningFallbackReason } from "./reasoning-fallback";
import * as core from "@actions/core";

export interface ChatCompletionResult {
  content: string;
  model?: string;
}

export type LlmProgressHandler = (detail: string) => void | Promise<void>;

type OpenRouterReasoningRequest = {
  reasoning?: { effort: string; exclude: boolean };
};

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens?: number;
  private maxAttempts: number;
  private routerModel: boolean;
  private temperature: number;
  private onProgress?: LlmProgressHandler;
  private reasoningEffort?: string;
  private reasoningFallbackActive = false;
  private reasoningFallbackReason?: ReasoningFallbackReason;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    maxOutputTokens?: number,
    // 刻意**不给**默认值。给了就会把「未配置」变成 DEFAULT_LLM_TIMEOUT_MS，
    // 于是 resolveLlmTimeoutMs 无法区分「没配」与「显式配了 600000」，
    // 后者会被对 OpenRouter 路由模型静默降级成 120000ms。
    // 传 undefined 一路传到 resolveLlmTimeoutMs，由它按模型选默认值。
    timeoutMs?: number,
    maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
    temperature = DEFAULT_LLM_TEMPERATURE,
    onProgress?: LlmProgressHandler,
    reasoningEffort?: string
  ) {
    this.model = model;
    this.temperature = temperature;
    this.routerModel = isOpenRouterRouterModel(model);
    this.onProgress = onProgress;
    this.reasoningEffort = reasoningEffort?.trim() || undefined;
    this.maxOutputTokens =
      maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;
    this.maxAttempts = getLlmCompletionAttemptCount(maxAttempts, model);
    const effectiveTimeoutMs = resolveLlmTimeoutMs(model, timeoutMs);

    core.info(
      `Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${effectiveTimeoutMs} ms, maxAttempts=${this.maxAttempts}, temperature=${this.temperature}`
    );

    // ponytail: chatCompletion owns retries; SDK maxRetries × 10-min timeout burned whole job budgets
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 0,
      timeout: effectiveTimeoutMs,
    });

    if (this.routerModel) {
      core.info(
        `OpenRouter router model — ${DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS / 1000}s first-chunk stall detect, ${effectiveTimeoutMs / 1000}s stream cap, provider fallbacks.`
      );
    }
  }

  private retryContext() {
    return { model: this.model };
  }

  getReasoningFallbackReason(): ReasoningFallbackReason | undefined {
    return this.reasoningFallbackReason;
  }

  private async progress(detail: string): Promise<void> {
    if (!this.onProgress) return;
    try {
      await this.onProgress(detail);
    } catch (error) {
      core.warning(`LLM progress update failed (non-fatal): ${error}`);
    }
  }

  async chatCompletion(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode = false
  ): Promise<ChatCompletionResult> {
    let lastFinishReason = "unknown";
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const useJson = shouldUseJsonResponseMode(attempt, jsonResponseMode);

      try {
        core.info(`LLM attempt ${attempt}/${this.maxAttempts}: waiting for provider...`);
        await this.progress(
          `Waiting for provider (attempt ${attempt}/${this.maxAttempts})…`
        );
        const { content, model: resolvedModel } = await this.performRequest(
          systemPrompt,
          userContent,
          useJson
        );

        if (content) {
          if (!this.routerModel) {
            this.logResolvedModel(resolvedModel || this.model);
          }
          return { content, model: resolvedModel };
        }

        lastFinishReason = "empty";
        core.warning(
          `LLM attempt ${attempt}/${this.maxAttempts}: empty content${useJson ? " (json mode)" : ""}`
        );
      } catch (error) {
        lastError = error;
        core.warning(`LLM attempt ${attempt}/${this.maxAttempts} failed: ${error}`);

        if (!isRetriableLlmError(error, this.retryContext()) || attempt === this.maxAttempts) {
          core.error(`LLM API error: ${error}`);
          // 保留 cause：包装后 status 与完整错误链会丢，
          // 上层要靠它判断「是不是出口瞬时故障、该不该换个 CI 继续审查」。
          throw new Error(`Failed to get response from LLM: ${error}`, { cause: error });
        }
      }

      if (attempt < this.maxAttempts) {
        const waitMs = computeRetryDelayMs(attempt, this.retryContext());
        const reason = lastError instanceof Error ? lastError.message : "empty response";
        core.info(`Retrying LLM request in ${waitMs} ms (attempt ${attempt + 1}/${this.maxAttempts})...`);
        await this.progress(
          `Attempt ${attempt} did not succeed (${reason}). Retrying in ${Math.round(waitMs / 1000)}s…`
        );
        await delayMs(waitMs);
      }
    }

    // 走到这里时，**最后一次 attempt 必然是"返回了空正文"**，可证：
    //   末次 attempt 一旦抛错，:146 的 `attempt === this.maxAttempts` 会先抛出去，
    //   根本到不了这个分支；而返回非空正文则在 :135 直接 return。
    // 所以 `lastError`（如果非空）来自**更早的某次** attempt ——
    // 它描述的不是最终结局。
    //
    // 但**不能**因此把 lastError 丢掉或清空：上层 `isTransientEgressFailure` 靠
    // `llmErrorStatus` 沿 cause 链读 provider 的 `status`/`code`，而「空正文」这个
    // 结局**根本没有 status 可给**。R925 的两条测试就是为了钉这件事：
    // 丢掉 cause ⇒ 一次 status-only 的 503 瞬断被判成不可重试（不重启），
    // 或者一次 ENOTFOUND 永久故障被洗成瞬时（无限重启 CI）。
    // 因此 `cause` 原样保留 lastError，只把**正文**改成如实描述两件事。
    //
    // 也不重算 isRetriableLlmError：能走到这里说明 lastError 必然是可重试的那个
    // （不可重试的早在 catch 里抛了）。重算既冗余，又会在谓词日后变得依赖运行时
    // 状态时把真实的 provider 错误误报成「空响应」。
    if (lastError) {
      core.error(
        `LLM API error after ${this.maxAttempts} attempts: last attempt returned empty ` +
          `content; an earlier attempt failed with: ${lastError}`
      );
      throw new Error(
        `Failed to get response from LLM after ${this.maxAttempts} attempts: ` +
          `last attempt returned empty content; an earlier attempt failed with: ${lastError}`,
        { cause: lastError }
      );
    }

    // 这里**故意不挂 cause**：走到这个分支意味着每次 attempt 都正常返回了
    // HTTP 响应、只是正文为空（finish_reason 记在消息里），根本没有底层
    // 异常可挂。硬造一个 cause 只会污染错误链、误导上层分类器。
    throw new Error(
      `Empty response from LLM after ${this.maxAttempts} attempts (finish_reason=${lastFinishReason})`
    );
  }

  /**
   * One completion request. If the provider rejects the reasoning parameter as
   * unsupported or rejects its configured value, warn and retry once without it;
   * the fallback then stays off so normal retry attempts are not multiplied.
   */
  private async performRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): Promise<ChatCompletionResult> {
    try {
      return await this.dispatch(this.buildRequest(systemPrompt, userContent, jsonResponseMode));
    } catch (error) {
      if (this.reasoningFallbackActive || !this.reasoningEffort) {
        throw error;
      }

      const fallbackReason = isUnsupportedReasoningEffortError(error, this.reasoningEffort)
        ? "unsupported"
        : isInvalidReasoningEffortError(error, this.reasoningEffort)
          ? "invalid-value"
          : undefined;
      if (!fallbackReason) throw error;

      this.reasoningFallbackActive = true;
      this.reasoningFallbackReason = fallbackReason;
      core.warning(
        `Provider rejected the configured reasoning effort as ${fallbackReason === "invalid-value" ? "invalid" : "unsupported"} (${errorMessage(error)}). ` +
          "Retrying once without the reasoning parameter and continuing this run without reasoning controls."
      );
      await this.progress(
        fallbackReason === "invalid-value"
          ? "Provider rejected the configured reasoning effort — retrying without it…"
          : "Provider rejected reasoning controls — retrying without them…"
      );
      return await this.dispatch(this.buildRequest(systemPrompt, userContent, jsonResponseMode));
    }
  }

  private async dispatch(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams & OpenRouterReasoningRequest
  ): Promise<ChatCompletionResult> {
    return this.routerModel
      ? await this.streamChatCompletion(request)
      : await this.blockingChatCompletion(request);
  }

  private async blockingChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams
  ): Promise<ChatCompletionResult> {
    const response = await this.client.chat.completions.create({
      ...request,
      stream: false,
    });
    return {
      content: this.extractMessageContent(response),
      model: response.model || this.model,
    };
  }

  /** Stream so the first SSE chunk (model id) proves OpenRouter routed; abort if none arrives. */
  private async streamChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams & OpenRouterReasoningRequest
  ): Promise<ChatCompletionResult> {
    const firstChunkMs = DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS;
    const controller = new AbortController();
    let gotFirstChunk = false;
    // ponytail: timer starts before create() so a hung TCP/connect also fails at firstChunkMs
    let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
    }, firstChunkMs);

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    try {
      const stream = await this.client.chat.completions.create(
        { ...request, stream: true },
        { signal: controller.signal }
      );

      const parts: string[] = [];
      let resolvedModel = this.model;

      for await (const chunk of stream) {
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          clearStallTimer();
          resolvedModel = chunk.model || resolvedModel;
          if (chunk.model && chunk.model !== this.model) {
            core.info(`LLM resolved model: ${chunk.model} (requested: ${this.model})`);
            await this.progress(`Routed to \`${chunk.model}\` — generating review…`);
          } else {
            core.info("OpenRouter stream started — provider accepted the request.");
            await this.progress("Provider accepted the request — generating review…");
          }
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          parts.push(delta);
        }
        if (chunk.model) {
          resolvedModel = chunk.model;
        }
      }

      return { content: parts.join(""), model: resolvedModel };
    } catch (error) {
      if (!gotFirstChunk) {
        // A 400/422 mentioning a reasoning request key is a definitive client response,
        // not a stalled router. Surface it even when the stricter fallback classifiers
        // reject it, so the provider's real validation error is not replaced by a stall.
        // Other failures keep the stall retry path.
        const status = Number((error as { status?: unknown })?.status);
        const mentionsReasoningObject = /\breasoning(?:[_-][\w.-]*)?\b/i.test(
          errorMessage(error)
        );
        if (
          request.reasoning !== undefined &&
          (isUnsupportedReasoningEffortError(error, request.reasoning.effort) ||
            isInvalidReasoningEffortError(error, request.reasoning.effort) ||
            ((status === 400 || status === 422) && mentionsReasoningObject))
        ) {
          throw error;
        }
        throw openRouterStallError(firstChunkMs);
      }
      throw error;
    } finally {
      // R1094：必须放 `finally`，不能用「首个 chunk 时清理 + catch 里清理」。
      // 若流**零 chunk 正常结束**（网关返回 200 但只给 `[DONE]`，或空 SSE），
      // 循环体一次都不进 ⇒ 两处清理都不执行 ⇒ 45s 的 setTimeout 泄漏，
      // 把 Node 事件循环多拖住最长 firstChunkMs 才退出；每次空尝试还会叠加一个。
      // `finally` 覆盖成功返回、抛错、零 chunk 三条路径。
      clearStallTimer();
    }
  }

  private buildRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): OpenAI.Chat.Completions.ChatCompletionCreateParams & OpenRouterReasoningRequest {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParams & OpenRouterReasoningRequest = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: this.temperature,
    };

    if (this.maxOutputTokens) {
      request.max_tokens = this.maxOutputTokens;
    }

    if (jsonResponseMode) {
      request.response_format = { type: "json_object" };
    }

    if (this.reasoningEffort && !this.reasoningFallbackActive) {
      request.reasoning = {
        effort: this.reasoningEffort,
        exclude: true,
      };
    }

    if (this.routerModel) {
      // OpenRouter extension: try other providers when the first free route 404s.
      (request as OpenAI.Chat.Completions.ChatCompletionCreateParams & {
        provider?: { allow_fallbacks: boolean };
      }).provider = { allow_fallbacks: true };
    }

    return request;
  }

  private logResolvedModel(resolvedModel: string): void {
    if (resolvedModel && resolvedModel !== this.model) {
      core.info(`LLM resolved model: ${resolvedModel} (requested: ${this.model})`);
    } else {
      core.info(`LLM response model: ${resolvedModel}`);
    }
  }

  private extractMessageContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices?.[0];
    if (!choice) {
      core.warning("LLM response has no choices array.");
      return "";
    }

    const content = choice.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }

    core.warning(
      `LLM choice has no text content (finish_reason=${choice.finish_reason || "unknown"}).`
    );
    return "";
  }
}
