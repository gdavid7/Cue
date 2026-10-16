import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmUseCase } from "@/utils/llms/use-cases";
import { saveAiUsage } from "@/utils/usage";
import { toolCallAgentStream } from "./index";
import { INTERRUPTED_RESPONSE_NOTICE } from "./stream-fallback-model";

const { mockGetModelForUseCase, mockCreateBridgedClaudeCodeModel } = vi.hoisted(
  () => ({
    mockGetModelForUseCase: vi.fn(),
    mockCreateBridgedClaudeCodeModel: vi.fn(),
  }),
);

vi.mock("@/utils/llms/cli-provider", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llms/cli-provider")>()),
  createClaudeCodeLanguageModelWithBridgedTools:
    mockCreateBridgedClaudeCodeModel,
}));

vi.mock("@/utils/llms/use-cases", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: mockGetModelForUseCase,
}));

vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: vi.fn().mockResolvedValue({ shouldForce: false }),
}));

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: vi.fn(() => undefined),
  isPosthogLlmEvalApproved: vi.fn(() => false),
}));

describe("toolCallAgentStream abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start further tool calls once the run is stopped", async () => {
    const controller = new AbortController();
    // The stop lands while the first tool call is running.
    const archive = vi.fn(async () => {
      controller.abort();
      return "archived";
    });
    mockGetModelForUseCase.mockReturnValue({
      provider: "openai",
      modelName: "test-model",
      model: createToolCallingModel(),
      fallbackModels: [],
      hasUserApiKey: true,
    });

    const result = await toolCallAgentStream({
      userAi: { aiProvider: null, aiModel: null, aiApiKey: null },
      userEmail: "user@test.com",
      emailAccountId: "email-account-id",
      useCase: LlmUseCase.AssistantChat,
      usageLabel: "test",
      promptHardening: { trust: "untrusted", level: "full" },
      messages: [{ role: "user", content: "Archive everything" }],
      tools: {
        archive: tool({ inputSchema: z.object({}), execute: archive }),
      },
      abortSignal: controller.signal,
    });

    const chunkTypes: string[] = [];
    for await (const chunk of result.toUIMessageStream()) {
      chunkTypes.push(chunk.type);
    }

    expect(chunkTypes).toContain("abort");
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

describe("toolCallAgentStream usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records each step's usage so per-request pricing tiers apply", async () => {
    const primary = createScriptedModel("primary", [
      [STREAM_START, toolCall("call-1", "archive"), finish("tool-calls")],
      [STREAM_START, ...textParts("Done"), finish("stop")],
    ]);

    await runAgent({
      primary,
      tools: { archive: async () => "archived" },
    });

    const [usageEvent] = vi.mocked(saveAiUsage).mock.calls[0];
    expect(usageEvent.stepUsages).toHaveLength(2);
    expect(usageEvent.stepUsages?.[0]).toMatchObject({ inputTokens: 1 });
  });
});

describe("toolCallAgentStream model fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers from the fallback when the primary still fails after one quick retry", async () => {
    const primary = createScriptedModel("primary", [
      failedCall(),
      failedCall(),
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(run.errorChunks).toHaveLength(0);
    expect(run.resolvedModels).toEqual(["primary-model", "fallback-model"]);
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(saveAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "fallback-model",
        modelFallbacks: [
          {
            fromProvider: "google",
            fromModel: "primary-model",
            toProvider: "google",
            toModel: "fallback-model",
            reason: "server_error",
          },
        ],
      }),
    );
  });

  it("records a billing-limit outage under its own fallback reason", async () => {
    const creditError = new APICallError({
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: creditError }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(saveAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelFallbacks: [expect.objectContaining({ reason: "billing_limit" })],
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("switching to fallback model"),
    );
    errorLog.mockRestore();
  });

  it("answers from the primary when its quick retry succeeds", async () => {
    const primary = createScriptedModel("primary", [
      failedCall(),
      [STREAM_START, ...textParts("Primary answer"), finish("stop")],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Should not run"), finish("stop")],
    ]);

    const startedAt = Date.now();
    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Primary answer");
    expect(run.resolvedModels).toEqual(["primary-model"]);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("falls back without retrying when the provider asks for a longer wait", async () => {
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: rateLimitError("30") }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(primary.doStreamCalls).toHaveLength(1);
  });

  it("falls back when the primary is overloaded", async () => {
    const overloaded = new APICallError({
      message: "Overloaded",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 529,
      responseBody:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      isRetryable: true,
    });
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: overloaded }],
      [STREAM_START, { type: "error", error: overloaded }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
  });

  it("surfaces a request error the fallback would not fix instead of switching", async () => {
    const badRequest = new APICallError({
      message: "messages: text content blocks must be non-empty",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: badRequest }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Should not run"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.errorChunks).toHaveLength(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(primary.doStreamCalls).toHaveLength(1);
  });

  it("answers from the fallback when the primary call is rejected outright", async () => {
    const primary = createScriptedModel("primary", []);
    primary.doStream = async () => {
      throw overloadedError();
    };
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(run.errorChunks).toHaveLength(0);
  });

  it("keeps streamed text and ends with a notice instead of re-answering on the fallback", async () => {
    const primary = createScriptedModel("primary", [
      [
        STREAM_START,
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Partial answer" },
        { type: "error", error: overloadedError() },
      ],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Should not run"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe(`Partial answer\n\n${INTERRUPTED_RESPONSE_NOTICE}`);
    expect(run.errorChunks).toHaveLength(0);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(run.finishReason).toBe("error");
    // The interrupted call reports no usage, so the run's total is a floor.
    expect(saveAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "primary-model",
        usageIncomplete: true,
      }),
    );
  });

  it("continues on the fallback after a write tool ran without running it again", async () => {
    const archive = vi.fn(async () => "archived");
    const primary = createScriptedModel("primary", [
      [STREAM_START, toolCall("call-1", "archive"), finish("tool-calls")],
      failedCall(),
      failedCall(),
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Archived it."), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback, tools: { archive } });

    expect(archive).toHaveBeenCalledTimes(1);
    expect(run.text).toBe("Archived it.");
    expect(run.errorChunks).toHaveLength(0);
    expect(JSON.stringify(fallback.doStreamCalls[0].prompt)).toContain(
      "archived",
    );
  });

  it("drops a tool call the failed primary streamed so only the fallback's call runs", async () => {
    const archive = vi.fn(async () => "archived");
    const primary = createScriptedModel("primary", [
      [
        STREAM_START,
        toolCall("call-1", "archive"),
        { type: "error", error: overloadedError() },
      ],
      failedCall(),
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, toolCall("call-2", "archive"), finish("tool-calls")],
      [STREAM_START, ...textParts("Archived it."), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback, tools: { archive } });

    expect(archive).toHaveBeenCalledTimes(1);
    expect(run.toolCallIds).toEqual(["call-2"]);
    expect(run.text).toBe("Archived it.");
    expect(run.errorChunks).toHaveLength(0);
  });

  it("does not fall back once the run is stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: overloadedError() }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Should not run"), finish("stop")],
    ]);

    await runAgent({ primary, fallback, abortSignal: controller.signal });

    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("surfaces the error when no fallback is configured", async () => {
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: overloadedError() }],
    ]);

    const run = await runAgent({ primary });

    expect(run.errorChunks).toHaveLength(1);
  });

  it("drops the failed primary's hidden reasoning and files so neither the user nor the fallback sees them", async () => {
    const primary = createScriptedModel("primary", [
      [
        STREAM_START,
        { type: "reasoning-start", id: "r1" },
        {
          type: "reasoning-delta",
          id: "r1",
          delta: "",
          providerMetadata: { anthropic: { redactedData: "primary-secret" } },
        },
        { type: "reasoning-end", id: "r1" },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "cHJpbWFyeQ==" },
        },
        { type: "error", error: overloadedError() },
      ],
      failedCall(),
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(run.chunkTypes).not.toContain("reasoning-start");
    expect(run.chunkTypes).not.toContain("file");
    expect(run.errorChunks).toHaveLength(0);
  });

  it("does not hand the failed primary's reasoning to the fallback on a later step", async () => {
    const archive = vi.fn(async () => "archived");
    const primary = createScriptedModel("primary", [
      [STREAM_START, toolCall("call-1", "archive"), finish("tool-calls")],
      [
        STREAM_START,
        { type: "reasoning-start", id: "r1" },
        {
          type: "reasoning-delta",
          id: "r1",
          delta: "",
          providerMetadata: { anthropic: { signature: "primary-signature" } },
        },
        { type: "error", error: overloadedError() },
      ],
      failedCall(),
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, toolCall("call-2", "archive"), finish("tool-calls")],
      [STREAM_START, ...textParts("Archived both."), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback, tools: { archive } });

    expect(run.text).toBe("Archived both.");
    expect(JSON.stringify(fallback.doStreamCalls[1].prompt)).not.toContain(
      "primary-signature",
    );
    expect(run.chunkTypes).not.toContain("reasoning-start");
  });

  it("keeps visible reasoning and ends with a notice instead of re-answering on the fallback", async () => {
    const primary = createScriptedModel("primary", [
      [
        STREAM_START,
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "Looking at the inbox" },
        { type: "error", error: overloadedError() },
      ],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Should not run"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.reasoning).toBe("Looking at the inbox");
    expect(run.text).toBe(`\n\n${INTERRUPTED_RESPONSE_NOTICE}`);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(run.errorChunks).toHaveLength(0);
  });
});

describe("toolCallAgentStream with a single model candidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams a tool's input as it arrives when no fallback is configured", async () => {
    const { model, release } = createGatedToolInputModel();
    mockGetModelForUseCase.mockReturnValue({
      provider: "google",
      modelName: "primary-model",
      model,
      fallbackModels: [],
      hasUserApiKey: false,
    });

    const result = await toolCallAgentStream({
      ...BASE_AGENT_OPTIONS,
      tools: { archive: archiveTool() },
    });

    expect(await toolInputStreamsBeforeCallEnds(result, release)).toBe(true);
  });

  it("streams a bridged Claude Code run's tool activity live even with fallbacks configured", async () => {
    const { model, release } = createGatedToolInputModel();
    mockCreateBridgedClaudeCodeModel.mockResolvedValue(model);
    mockGetModelForUseCase.mockReturnValue({
      provider: "claude-code",
      modelName: "sonnet",
      model: new MockLanguageModelV4(),
      fallbackModels: [
        {
          provider: "google",
          modelName: "fallback-model",
          model: createScriptedModel("fallback", []),
        },
      ],
      hasUserApiKey: false,
    });

    const result = await toolCallAgentStream({
      ...BASE_AGENT_OPTIONS,
      tools: { archive: archiveTool() },
    });

    expect(await toolInputStreamsBeforeCallEnds(result, release)).toBe(true);
  });
});

const BASE_AGENT_OPTIONS = {
  userAi: { aiProvider: null, aiModel: null, aiApiKey: null },
  userEmail: "user@test.com",
  emailAccountId: "email-account-id",
  useCase: LlmUseCase.AssistantChat,
  usageLabel: "test",
  promptHardening: { trust: "untrusted", level: "full" },
  messages: [{ role: "user", content: "Archive it" }],
} as const;

function archiveTool() {
  return tool({ inputSchema: z.object({}), execute: async () => "archived" });
}

// The model's call streams a tool-input-start, then waits until released, as
// a CLI run does while it executes a tool.
function createGatedToolInputModel() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue(STREAM_START);
            controller.enqueue({
              type: "tool-input-start",
              id: "call-1",
              toolName: "archive",
            });
            await gate;
            controller.enqueue({
              type: "tool-input-delta",
              id: "call-1",
              delta: "{}",
            });
            controller.enqueue({ type: "tool-input-end", id: "call-1" });
            controller.enqueue(finish("stop"));
            controller.close();
          },
        }),
      },
    ],
  });
  return { model, release: () => release() };
}

async function toolInputStreamsBeforeCallEnds(
  result: Awaited<ReturnType<typeof toolCallAgentStream>>,
  release: () => void,
) {
  let released = false;
  const releaseOnce = () => {
    released = true;
    release();
  };
  // A held tool input only shows up once the call ends, so stop waiting.
  const timeout = setTimeout(releaseOnce, 2000);
  let seenWhileRunning = false;
  for await (const chunk of result.toUIMessageStream()) {
    if (chunk.type === "tool-input-start" && !released) {
      seenWhileRunning = true;
      releaseOnce();
    }
  }
  clearTimeout(timeout);
  return seenWhileRunning;
}

const STREAM_START: LanguageModelV4StreamPart = {
  type: "stream-start",
  warnings: [],
};

async function runAgent({
  primary,
  fallback,
  tools = {},
  abortSignal,
}: {
  primary: MockLanguageModelV4;
  fallback?: MockLanguageModelV4;
  tools?: Record<string, () => Promise<string>>;
  abortSignal?: AbortSignal;
}) {
  const resolvedModels: string[] = [];
  mockGetModelForUseCase.mockReturnValue({
    provider: "google",
    modelName: "primary-model",
    model: primary,
    fallbackModels: fallback
      ? [{ provider: "google", modelName: "fallback-model", model: fallback }]
      : [],
    hasUserApiKey: false,
  });

  let finishReason: string | undefined;
  const result = await toolCallAgentStream({
    userAi: { aiProvider: null, aiModel: null, aiApiKey: null },
    userEmail: "user@test.com",
    emailAccountId: "email-account-id",
    useCase: LlmUseCase.AssistantChat,
    usageLabel: "test",
    promptHardening: { trust: "untrusted", level: "full" },
    messages: [{ role: "user", content: "Help with my inbox" }],
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, execute]) => [
        name,
        tool({ inputSchema: z.object({}), execute }),
      ]),
    ),
    stopWhen: () => false,
    onModelResolved: (model) => resolvedModels.push(model.modelName ?? ""),
    onEnd: (event) => {
      finishReason = event.finishReason;
    },
    abortSignal,
  });

  let text = "";
  let reasoning = "";
  const errorChunks: unknown[] = [];
  const toolCallIds: string[] = [];
  const chunkTypes: string[] = [];
  for await (const chunk of result.toUIMessageStream()) {
    chunkTypes.push(chunk.type);
    if (chunk.type === "text-delta") text += chunk.delta;
    if (chunk.type === "reasoning-delta") reasoning += chunk.delta;
    if (chunk.type === "error") errorChunks.push(chunk);
    if (chunk.type === "tool-input-available") {
      toolCallIds.push(chunk.toolCallId);
    }
  }

  return {
    text,
    reasoning,
    errorChunks,
    toolCallIds,
    chunkTypes,
    resolvedModels,
    finishReason,
  };
}

function createScriptedModel(
  name: string,
  calls: LanguageModelV4StreamPart[][],
) {
  return new MockLanguageModelV4({
    provider: "google",
    modelId: `${name}-model`,
    doStream: calls.map((chunks) => ({
      stream: simulateReadableStream({ chunks }),
    })),
  });
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
  ];
}

function toolCall(
  toolCallId: string,
  toolName: string,
): LanguageModelV4StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: "{}" };
}

function finish(unified: "stop" | "tool-calls"): LanguageModelV4StreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  };
}

function failedCall(): LanguageModelV4StreamPart[] {
  return [STREAM_START, { type: "error", error: overloadedError() }];
}

function rateLimitError(retryAfterSeconds: string) {
  return new APICallError({
    message: "Rate limit exceeded",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": retryAfterSeconds },
    isRetryable: true,
  });
}

function overloadedError() {
  return new APICallError({
    message: "The model is overloaded",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
}

function createToolCallingModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "archive",
            input: "{}",
          },
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "archive",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}
