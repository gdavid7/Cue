import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSONParseError, TypeValidationError } from "@ai-sdk/provider";
import { NoObjectGeneratedError, RetryError } from "ai";
import { withNetworkRetry } from "./retry";

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: mockGenerateObject,
}));

vi.mock("@/env", () => ({
  env: {
    NODE_ENV: "test",
    ENABLE_DEBUG_LOGS: true,
    NANO_LLMS: "",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    EMAIL_ENCRYPT_SALT: "test-salt",
  },
}));

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));
vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/error-messages", () => ({
  addUserErrorMessageWithNotification: vi.fn(),
  ErrorType: {},
}));
vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: vi.fn().mockResolvedValue({ shouldForce: false }),
}));
vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: vi.fn(() => undefined),
  isPosthogLlmEvalApproved: vi.fn(() => false),
}));

const MODEL_OUTPUT = "Dear Alice, your invoice for the Acme merger is attached";

describe("LLM call error logging", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "JSONParseError",
      createError: () =>
        new JSONParseError({
          text: MODEL_OUTPUT,
          cause: new Error(`Unexpected token in ${MODEL_OUTPUT}`),
        }),
    },
    {
      name: "TypeValidationError",
      createError: () =>
        new TypeValidationError({
          value: { summary: MODEL_OUTPUT },
          cause: new Error(`Invalid input: ${MODEL_OUTPUT}`),
        }),
    },
    {
      name: "NoObjectGeneratedError",
      createError: () =>
        new NoObjectGeneratedError({
          message: `No object generated: ${MODEL_OUTPUT}`,
          text: MODEL_OUTPUT,
          response: {
            id: "r1",
            timestamp: new Date(),
            modelId: "gpt-test",
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          } as never,
          finishReason: "stop",
        }),
    },
    {
      name: "JSONParseError",
      label: "a RetryError whose lastError is one",
      createError: () =>
        new RetryError({
          message: `Failed after 3 attempts. Last error: ${MODEL_OUTPUT}`,
          reason: "maxRetriesExceeded",
          errors: [new Error("first"), createJsonParseError()],
        }),
    },
    {
      name: "JSONParseError",
      label: "a RetryError that holds one in errors[]",
      createError: () =>
        new RetryError({
          message: "Failed after 3 attempts.",
          reason: "maxRetriesExceeded",
          errors: [createJsonParseError(), new Error("last")],
        }),
    },
    {
      name: "TypeValidationError",
      label: "an Error whose cause is one",
      createError: () =>
        new Error("wrapper", {
          cause: new TypeValidationError({
            value: { summary: MODEL_OUTPUT },
            cause: new Error(`Invalid input: ${MODEL_OUTPUT}`),
          }),
        }),
    },
  ])("keeps model output from $name ($label) out of warn and error logs", async ({
    name,
    createError,
  }) => {
    mockGenerateObject.mockRejectedValue(createError());
    const generateObject = await createTestGenerateObject();

    await expect(
      generateObject({ prompt: "Summarize", schema: {} as never } as never),
    ).rejects.toBeDefined();

    const warnAndError = consoleOutput(errorSpy, warnSpy);
    expect(warnAndError).toContain("Error in LLM call");
    expect(warnAndError).toContain(name);
    expect(warnAndError).not.toContain(MODEL_OUTPUT);
    expect(warnAndError).not.toContain("Acme");

    const traceOutput = consoleOutput(logSpy);
    expect(traceOutput).toContain("Error in LLM call (full error)");
  });

  it("keeps the error in the log for failures that carry no model output", async () => {
    mockGenerateObject.mockRejectedValue(new Error("provider exploded"));
    const generateObject = await createTestGenerateObject();

    await expect(
      generateObject({ prompt: "Summarize", schema: {} as never } as never),
    ).rejects.toThrow("provider exploded");

    expect(consoleOutput(errorSpy)).toContain("provider exploded");
  });

  it("keeps model output out of the validation retry warning", async () => {
    const validationError = new TypeValidationError({
      value: { summary: MODEL_OUTPUT },
      cause: new Error(`Invalid input: ${MODEL_OUTPUT}`),
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(validationError)
      .mockResolvedValue("ok");

    await expect(
      withNetworkRetry(fn, { label: "test", shouldRetry: () => true }),
    ).resolves.toBe("ok");

    const warnOutput = consoleOutput(warnSpy);
    expect(warnOutput).toContain("Retrying after validation error");
    expect(warnOutput).toContain("TypeValidationError");
    expect(warnOutput).not.toContain(MODEL_OUTPUT);
    expect(consoleOutput(logSpy)).toContain("(full error)");
  });

  it("keeps the message of a retried non-AI error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue("ok");

    await withNetworkRetry(fn, { label: "test", shouldRetry: () => true });

    expect(consoleOutput(warnSpy)).toContain("socket hang up");
  });
});

function createJsonParseError() {
  return new JSONParseError({
    text: MODEL_OUTPUT,
    cause: new Error(`Unexpected token in ${MODEL_OUTPUT}`),
  });
}

function consoleOutput(...spies: Array<{ mock: { calls: unknown[][] } }>) {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join("\n");
}

async function createTestGenerateObject() {
  const { createGenerateObject } = await import("./index");

  return createGenerateObject({
    emailAccount: {
      id: "account-1",
      email: "user@example.com",
      userId: "user-1",
    },
    label: "test",
    modelOptions: {
      provider: "openai",
      modelName: "gpt-test",
      model: {} as never,
      providerOptions: undefined,
      hasUserApiKey: false,
      fallbackModels: [],
    } as never,
    promptHardening: { trust: "untrusted", level: "full" },
  });
}
