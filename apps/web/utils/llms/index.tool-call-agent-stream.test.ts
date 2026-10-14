import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmUseCase } from "@/utils/llms/use-cases";
import { toolCallAgentStream } from "./index";
import { INTERRUPTED_RESPONSE_NOTICE } from "./stream-fallback-model";

const { mockGetModelForUseCase } = vi.hoisted(() => ({
  mockGetModelForUseCase: vi.fn(),
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

describe("toolCallAgentStream model fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers from the fallback when the primary errors mid-stream before any output", async () => {
    const primary = createScriptedModel("primary", [
      [STREAM_START, { type: "error", error: overloadedError() }],
    ]);
    const fallback = createScriptedModel("fallback", [
      [STREAM_START, ...textParts("Fallback answer"), finish("stop")],
    ]);

    const run = await runAgent({ primary, fallback });

    expect(run.text).toBe("Fallback answer");
    expect(run.errorChunks).toHaveLength(0);
    expect(run.resolvedModels).toEqual(["primary-model", "fallback-model"]);
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
  });

  it("continues on the fallback after a write tool ran without running it again", async () => {
    const archive = vi.fn(async () => "archived");
    const primary = createScriptedModel("primary", [
      [STREAM_START, toolCall("call-1", "archive"), finish("tool-calls")],
      [STREAM_START, { type: "error", error: overloadedError() }],
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
});

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
  const errorChunks: unknown[] = [];
  const toolCallIds: string[] = [];
  for await (const chunk of result.toUIMessageStream()) {
    if (chunk.type === "text-delta") text += chunk.delta;
    if (chunk.type === "error") errorChunks.push(chunk);
    if (chunk.type === "tool-input-available") {
      toolCallIds.push(chunk.toolCallId);
    }
  }

  return { text, errorChunks, toolCallIds, resolvedModels, finishReason };
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
