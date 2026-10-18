import { generateText, Output, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env } from "@/env";
import { getModel, type ModelType } from "./model";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    ANTHROPIC_API_KEY: "test-anthropic-key",
  },
}));

const ROLES: ModelType[] = ["default", "economy", "chat", "nano", "draft"];
const ENV_KEY_BY_ROLE = {
  default: "DEFAULT_LLMS",
  economy: "ECONOMY_LLMS",
  chat: "CHAT_LLMS",
  nano: "NANO_LLMS",
  draft: "DRAFT_LLMS",
} as const satisfies Record<ModelType, string>;
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

describe.each([
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
])("Anthropic request for %s", (modelName) => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: modelName,
            content: [{ type: "text", text: '{"answer":"ok"}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(
    ROLES,
  )("sends a request the API accepts for the %s role", async (role) => {
    for (const key of Object.values(ENV_KEY_BY_ROLE)) {
      vi.mocked(env)[key] = undefined;
    }
    vi.mocked(env)[ENV_KEY_BY_ROLE[role]] = `anthropic:${modelName}`;
    const { model, providerOptions } = getModel(
      { aiProvider: null, aiModel: null, aiApiKey: null },
      role,
    );

    await generateText({
      model,
      prompt: "hello",
      providerOptions,
      tools: { lookup: tool({ inputSchema: z.object({ q: z.string() }) }) },
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const headers = new Headers(init.headers);

    expect(body.model).toBe(modelName);
    expect(VALID_EFFORTS).toContain(body.output_config.effort);
    expect(body.thinking.type).toBe("adaptive");
    expect(body.thinking).not.toHaveProperty("budget_tokens");
    expect(body.tool_choice?.type).not.toBe("any");
    expect(body.tool_choice?.type).not.toBe("tool");

    if (modelName === "claude-sonnet-5-5") {
      expect(body.fallbacks).toBe("default");
      expect(headers.get("anthropic-beta")).toContain(
        "server-side-fallback-2026-07-01",
      );
    } else {
      expect(body).not.toHaveProperty("fallbacks");
      expect(headers.get("anthropic-beta") ?? "").not.toContain(
        "server-side-fallback",
      );
    }
  });
});
