import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailAccountWithAi } from "@/utils/user/get";
import {
  extractBrief,
  getCachedThreadBrief,
  getThreadBrief,
} from "./get-thread-brief";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  generateObject: vi.fn(),
  assertHasAiAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/user/get", () => ({ getEmailAccountWithAi: vi.fn() }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      mocks.store.set(key, value);
    }),
  },
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
  mocks.store.clear();
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

describe("thread brief caching", () => {
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

  it("serves a reopened conversation from the cache, with no model call", async () => {
    const provider = providerWith([message("Pricing by Friday?")]);
    await brief(provider);

    const cached = await getCachedThreadBrief({
      emailAccountId: "a1",
      threadId: "t1",
      messageId: "msg1",
    });

    expect(cached?.summary).toBe("Sarah wants pricing by Friday.");
    await brief(provider);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });

  it("writes a fresh brief once a new message arrives", async () => {
    await brief(providerWith([message("Pricing by Friday?")]));
    await brief(
      providerWith([
        message("Pricing by Friday?"),
        message("Actually, Thursday.", { id: "msg2" }),
      ]),
    );

    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
  });

  it("keys the brief by the newest received message, not an unsent draft", async () => {
    await brief(
      providerWith([
        message("Pricing by Friday?"),
        message("Draft reply", { id: "draft1", labelIds: ["DRAFT"] }),
      ]),
    );

    await expect(
      getCachedThreadBrief({
        emailAccountId: "a1",
        threadId: "t1",
        messageId: "msg1",
      }),
    ).resolves.toMatchObject({ summary: "Sarah wants pricing by Friday." });
  });

  it("never hands one account the brief cached for another", async () => {
    await brief(providerWith([message("Pricing by Friday?")]));

    await expect(
      getCachedThreadBrief({
        emailAccountId: "a2",
        threadId: "t1",
        messageId: "msg1",
      }),
    ).resolves.toBeNull();
  });

  it("doesn't cache a failed model call, so the next open tries again", async () => {
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
