import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getEmailAccount } from "@/__tests__/helpers";
import type { MeetingBriefingData } from "@/utils/meeting-briefs/gather-context";
import { createGenerateObject, createGenerateText } from "@/utils/llms";
import { aiGenerateMeetingBriefing } from "./generate-briefing";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    PERPLEXITY_API_KEY: undefined,
    EMAIL_ENCRYPT_SECRET: "test-encrypt-secret-for-testing",
    EMAIL_ENCRYPT_SALT: "test-encrypt-salt-for-testing",
  },
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(),
  createGenerateText: vi.fn(),
}));
vi.mock("@/utils/llms/use-cases", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: vi.fn(() => ({
    provider: "anthropic",
    modelName: "claude-sonnet-5-5",
    model: { provider: "anthropic.messages", modelId: "claude-sonnet-5-5" },
    fallbackModels: [],
    hasUserApiKey: false,
  })),
}));
vi.mock("@/utils/ai/web-search", () => ({
  getWebSearchConfigForProvider: () => null,
}));
vi.mock("@/utils/ai/mcp/mcp-tools", () => ({
  createMcpToolsForAgent: vi.fn(async () => ({ tools: {}, cleanup: null })),
}));

describe("aiGenerateMeetingBriefing without search tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gets the briefing as structured output, which models that reject forced tool calls still honor", async () => {
    const briefing = {
      priorities: ["Confirm the Q1 rollout owner before Friday."],
      guests: [
        {
          name: "John Smith",
          email: "client@acme.com",
          bullets: ["Leads procurement at Acme."],
        },
      ],
    };
    const generateObject = vi.fn(async () => ({ object: briefing }));
    vi.mocked(createGenerateObject).mockReturnValue(generateObject as never);

    const result = await aiGenerateMeetingBriefing({
      briefingData: BRIEFING_DATA,
      emailAccount: getEmailAccount(),
      logger: createTestLogger(),
    });

    expect(result).toEqual(briefing);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(createGenerateText).not.toHaveBeenCalled();
  });

  it("gives the structured path the briefing writing rules the finalize tool carried", async () => {
    const generateObject = vi.fn(async () => ({
      object: { priorities: [], guests: [] },
    }));
    vi.mocked(createGenerateObject).mockReturnValue(generateObject as never);

    await aiGenerateMeetingBriefing({
      briefingData: BRIEFING_DATA,
      emailAccount: getEmailAccount(),
      logger: createTestLogger(),
    });

    // Anthropic's native structured output ignores a schema description, so
    // the rules travel in the instructions.
    const [options] = generateObject.mock.calls[0] as unknown as [
      { instructions: string },
    ];
    expect(options.instructions).toContain(
      "Submit the completed meeting briefing after reviewing the supplied email threads and past meetings.",
    );
    expect(options.instructions).toContain(
      "List only the requested external guests in guests.",
    );
  });

  it("asks for the briefing itself rather than a tool call it cannot make", async () => {
    const generateObject = vi.fn(async () => ({
      object: { priorities: [], guests: [] },
    }));
    vi.mocked(createGenerateObject).mockReturnValue(generateObject as never);

    await aiGenerateMeetingBriefing({
      briefingData: BRIEFING_DATA,
      emailAccount: getEmailAccount(),
      logger: createTestLogger(),
    });

    const [options] = generateObject.mock.calls[0] as unknown as [
      { prompt: string },
    ];
    expect(options.prompt.trimEnd()).toMatch(/Return the complete briefing\.$/);
    expect(options.prompt).not.toContain("finalizeBriefing");
  });
});

const BRIEFING_DATA: MeetingBriefingData = {
  event: {
    id: "upcoming",
    title: "Strategy Review",
    startTime: new Date("2026-10-20T15:00:00Z"),
    endTime: new Date("2026-10-20T16:00:00Z"),
    attendees: [
      { email: "user@test.com" },
      { email: "client@acme.com", name: "John Smith" },
    ],
  },
  externalGuests: [{ email: "client@acme.com", name: "John Smith" }],
  internalTeamMembers: [],
  emailThreads: [],
  pastMeetings: [],
};
