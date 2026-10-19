import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import { extractBrief, getThreadBrief } from "./get-thread-brief";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  assertHasAiAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/user/get", () => ({ getEmailAccountWithAi: vi.fn() }));
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => mocks.generateObject,
}));
vi.mock("@/utils/llms/use-cases", () => ({
  getModelForUseCase: () => ({}),
  LlmUseCase: { Summarise: "summarise" },
}));
vi.mock("@/utils/premium/limits", () => ({
  assertHasAiAccess: mocks.assertHasAiAccess,
}));

const message = (
  textPlain: string,
  overrides: Parameters<typeof getMockMessage>[0] = {},
) =>
  getMockMessage({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Renewal",
    textPlain,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  recordingRedis.reset();
});

describe("extractBrief", () => {
  it("leads with what the latest email asks for", () => {
    const brief = extractBrief([
      message(
        "Hi David,\n\nHope your week is going well. Can you confirm the SSO issue is fixed? Please send the updated pricing before Friday.\n\nThanks,\nSarah",
      ),
    ]);

    expect(brief).toEqual({
      summary:
        "Can you confirm the SSO issue is fixed? Please send the updated pricing before Friday.",
      keyPoints: [],
      source: "extract",
    });
  });

  it("falls back to the opening sentences when nothing is asked", () => {
    expect(
      extractBrief([
        message("The patch shipped last night. All users can sign in again."),
      ])?.summary,
    ).toBe("The patch shipped last night. All users can sign in again.");
  });

  it("returns null for an empty thread", () => {
    expect(extractBrief([])).toBeNull();
  });
});

describe("getThreadBrief", () => {
  it("uses the extract when no AI is available for the account", async () => {
    vi.mocked(getEmailAccountWithAi).mockResolvedValue(null);
    const provider = providerWith([message("Can you send the pricing?")]);

    const brief = await getThreadBrief({
      emailAccountId: "a1",
      threadId: "t1",
      emailProvider: provider,
      logger: createTestLogger(),
    });

    expect(brief).toMatchObject({
      summary: "Can you send the pricing?",
      source: "extract",
    });
  });

  it("returns null, rather than failing, when the thread can't be loaded", async () => {
    const provider = {
      getThread: vi.fn().mockRejectedValue(new Error("Not Found")),
    } as unknown as EmailProvider;

    await expect(
      getThreadBrief({
        emailAccountId: "a1",
        threadId: "missing",
        emailProvider: provider,
        logger: createTestLogger(),
      }),
    ).resolves.toBeNull();
  });
});

describe("thread brief and the server cache", () => {
  beforeEach(() => {
    vi.mocked(getEmailAccountWithAi).mockResolvedValue({
      userId: "u1",
      user: { aiApiKey: null },
    } as Awaited<ReturnType<typeof getEmailAccountWithAi>>);
    mocks.assertHasAiAccess.mockResolvedValue(undefined);
    mocks.generateObject.mockResolvedValue({
      object: { summary: "Sarah wants pricing by Friday.", keyPoints: [] },
    });
  });

  // RD-3: a brief is derived from the mail, so the browser keeps it.
  it("writes a brief without keeping it or the email in the server cache", async () => {
    await expect(
      brief(providerWith([message("Pricing by Friday?")])),
    ).resolves.toMatchObject({ summary: "Sarah wants pricing by Friday." });

    expect(recordingRedis.everythingWritten()).not.toContain("Sarah");
    expect(recordingRedis.everythingWritten()).not.toContain("Friday");
  });

  it("marks the email's own words when there's no AI access", async () => {
    mocks.assertHasAiAccess.mockRejectedValue(new Error("upgrade"));

    await expect(
      brief(providerWith([message("Can you send the pricing?")])),
    ).resolves.toMatchObject({
      summary: "Can you send the pricing?",
      source: "extract",
      aiUnavailable: true,
    });
  });

  it("falls back to the extract when the model fails, and tries the model next time", async () => {
    mocks.generateObject.mockRejectedValueOnce(new Error("overloaded"));
    const provider = providerWith([message("Can you send the pricing?")]);

    await expect(brief(provider)).resolves.toMatchObject({
      source: "extract",
    });
    await expect(brief(provider)).resolves.toMatchObject({ source: "ai" });
  });
});

function brief(provider: EmailProvider) {
  return getThreadBrief({
    emailAccountId: "a1",
    threadId: "t1",
    emailProvider: provider,
    logger: createTestLogger(),
  });
}

function providerWith(messages: ReturnType<typeof message>[]) {
  return {
    getThread: vi.fn(async () => ({ id: "t1", snippet: "", messages })),
  } as unknown as EmailProvider;
}
