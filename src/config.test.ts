import {
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_COMPLETION_ATTEMPTS,
  MIN_LLM_COMPLETION_ATTEMPTS,
  parseLLMMaxAttempts,
  parseLLMTemperature,
  parseLLMTimeout,
} from "./config";

describe("parseLLMTimeout", () => {
  it("returns the default for empty input", () => {
    const result = parseLLMTimeout("");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
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
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for negative values", () => {
    const result = parseLLMTimeout("-1000");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for zero", () => {
    const result = parseLLMTimeout("0");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for whitespace-only string", () => {
    const result = parseLLMTimeout("   ");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
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

