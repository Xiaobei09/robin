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

export function parseLLMTimeout(input: string): { value: number; valid: boolean } {
  if (!input) return { value: DEFAULT_LLM_TIMEOUT_MS, valid: true };
  const parsed = Number(input);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { value: parsed, valid: true };
  }
  return { value: DEFAULT_LLM_TIMEOUT_MS, valid: false };
}

export function parseLLMTemperature(input: string): { value: number; valid: boolean } {
  const trimmed = input.trim();
  if (!trimmed) return { value: DEFAULT_LLM_TEMPERATURE, valid: true };
  const parsed = Number(trimmed);
  // 0 is a legitimate value, so range-check instead of truthiness.
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_LLM_TEMPERATURE) {
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
  const parsed = Number(trimmed);
  // Integer check: "2.5" attempts is meaningless, and Math.floor would hide a typo.
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_LLM_COMPLETION_ATTEMPTS &&
    parsed <= MAX_LLM_COMPLETION_ATTEMPTS
  ) {
    return { value: parsed, valid: true };
  }
  return { value: undefined, valid: false };
}
