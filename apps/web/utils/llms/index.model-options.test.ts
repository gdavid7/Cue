import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerateObject, createGenerateText } from "./index";
import { getModel } from "./model";

const {
  mockGenerateObject,
  mockGenerateText,
  mockShouldForceNanoModel,
  mockExtractLLMErrorInfo,
} = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  mockGenerateText: vi.fn(),
  mockShouldForceNanoModel: vi.fn(),
  mockExtractLLMErrorInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: mockGenerateObject,
    generateText: mockGenerateText,
  };
});

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({
    provider: "anthropic.messages",
    modelId,
  })),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogle: vi.fn(() => (modelId: string) => ({
    provider: "google.generative-ai",
    modelId,
  })),
}));

vi.mock("@/env", () => ({
  env: {
    NODE_ENV: "test",
    EMAIL_ENCRYPT_SALT: "test-salt",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GOOGLE_API_KEY: "test-google-key",
    DEFAULT_LLMS: "anthropic:claude-sonnet-5,google:gemini-3.8-flash",
    DRAFT_LLMS: "anthropic:claude-sonnet-5,google:gemini-3.8-flash",
    ECONOMY_LLMS: "anthropic:claude-haiku-4-5,google:gemini-3.1-flash-lite",
    CHAT_LLMS: "anthropic:claude-haiku-4-5,google:gemini-3.1-flash-lite",
    NANO_LLMS: "anthropic:claude-haiku-4-5,google:gemini-3.1-flash-lite",
  },
}));

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: vi.fn(() => undefined),
  isPosthogLlmEvalApproved: vi.fn(() => false),
}));

vi.mock("@posthog/ai", () => ({ captureAiGeneration: vi.fn() }));

vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: mockShouldForceNanoModel,
}));

vi.mock("./retry", async () => {
  const actual = await vi.importActual<typeof import("./retry")>("./retry");
  return {
    ...actual,
    withLLMRetry: (operation: () => Promise<unknown>) => operation(),
    withNetworkRetry: (operation: () => Promise<unknown>) => operation(),
    extractLLMErrorInfo: mockExtractLLMErrorInfo,
  };
});

const NO_USER_AI = { aiProvider: null, aiModel: null, aiApiKey: null };

const EMAIL_ACCOUNT = {
  id: "account-1",
  userId: "user-1",
  email: "user@example.com",
};

const PROMPT_HARDENING = { trust: "untrusted", level: "compact" } as const;

const SPEND_LIMIT_HIT = {
  shouldForce: true,
  spendBucket: "default",
  weeklySpendUsd: 12,
  weeklyLimitUsd: 10,
};

// Callers spread their SelectModel into the request, as get-thread-brief does,
// so the request also carries the primary model's own providerOptions.
describe("per-model provider options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldForceNanoModel.mockResolvedValue({ shouldForce: false });
    mockExtractLLMErrorInfo.mockReturnValue({ retryable: false });
    mockGenerateObject.mockResolvedValue({ object: { ok: true } });
    mockGenerateText.mockResolvedValue({ text: "ok" });
  });

  it("sends a Claude 5 primary its adaptive thinking", async () => {
    await generateBrief();

    const [call] = getObjectCalls();
    expect(call.modelName).toBe("claude-sonnet-5");
    expect(call.anthropic).toMatchObject({ thinking: { type: "adaptive" } });
  });

  it("drops the Claude 5 primary's thinking and effort after the spend guard switches to a non-Claude-5 nano model", async () => {
    mockShouldForceNanoModel.mockResolvedValue(SPEND_LIMIT_HIT);
    failFirstCallWithRetryableError(mockGenerateObject, {
      object: { ok: true },
    });

    await generateBrief();

    const calls = getObjectCalls();
    expect(calls.map((call) => call.modelName)).toEqual([
      "claude-haiku-4-5",
      "gemini-3.1-flash-lite",
    ]);
    for (const call of calls) {
      expect(call.anthropic?.thinking).toBeUndefined();
      expect(call.anthropic?.effort).toBeUndefined();
      expect(call.anthropic?.fallbacks).toBeUndefined();
    }
  });

  it("does not carry the Claude 5 primary's thinking into its fallback model", async () => {
    failFirstCallWithRetryableError(mockGenerateObject, {
      object: { ok: true },
    });

    await generateBrief();

    const [primary, fallback] = getObjectCalls();
    expect(primary.modelName).toBe("claude-sonnet-5");
    expect(fallback.modelName).toBe("gemini-3.8-flash");
    expect(fallback.anthropic).toBeUndefined();
  });

  it("keeps provider options a caller sets on the request", async () => {
    const modelOptions = getModel(NO_USER_AI, "default");
    const generateObject = createGenerateObject({
      emailAccount: EMAIL_ACCOUNT,
      label: "Thread brief",
      modelOptions,
      promptHardening: PROMPT_HARDENING,
    });

    await generateObject({
      ...modelOptions,
      providerOptions: { google: { structuredOutputs: false } },
      prompt: "Summarise",
      schema: {} as any,
    } as any);

    const [request] = mockGenerateObject.mock.calls[0];
    expect(request.providerOptions.google).toEqual({
      structuredOutputs: false,
    });
    expect(request.providerOptions.anthropic).toMatchObject({
      thinking: { type: "adaptive" },
    });
  });

  it("drops the Claude 5 primary's thinking from generateText after the spend guard switches to nano", async () => {
    mockShouldForceNanoModel.mockResolvedValue(SPEND_LIMIT_HIT);
    const modelOptions = getModel(NO_USER_AI, "default");
    const generateText = createGenerateText({
      emailAccount: EMAIL_ACCOUNT,
      label: "Thread brief",
      modelOptions,
      promptHardening: PROMPT_HARDENING,
    });

    await generateText({ ...modelOptions, prompt: "Summarise" } as any);

    const [request] = mockGenerateText.mock.calls[0];
    expect(request.model.modelId).toBe("claude-haiku-4-5");
    expect(request.providerOptions.anthropic?.thinking).toBeUndefined();
    expect(request.providerOptions.anthropic?.effort).toBeUndefined();
  });
});

async function generateBrief() {
  const modelOptions = getModel(NO_USER_AI, "default");
  const generateObject = createGenerateObject({
    emailAccount: EMAIL_ACCOUNT,
    label: "Thread brief",
    modelOptions,
    promptHardening: PROMPT_HARDENING,
  });

  await generateObject({
    ...modelOptions,
    prompt: "Summarise",
    schema: {} as any,
  } as any);
}

function failFirstCallWithRetryableError(
  mock: ReturnType<typeof vi.fn>,
  result: unknown,
) {
  mock.mockRejectedValueOnce(new Error("overloaded")).mockResolvedValue(result);
  mockExtractLLMErrorInfo.mockReturnValue({ retryable: true });
}

function getObjectCalls(): Array<{
  modelName: string;
  anthropic?: Record<string, any>;
}> {
  return mockGenerateObject.mock.calls.map(([request]) => ({
    modelName: request.model.modelId,
    anthropic: request.providerOptions?.anthropic,
  }));
}
