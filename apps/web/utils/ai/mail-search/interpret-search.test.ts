import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import { createScopedLogger } from "@/utils/logger";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  hasAiAccess: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => ({
    userId: "user-1",
    email: "david@example.com",
    timezone: "America/Los_Angeles",
    user: { aiApiKey: null, aiProvider: null, aiModel: null },
  }),
}));
vi.mock("@/utils/premium/limits", () => ({
  assertHasAiAccess: async () => {
    if (!mocks.hasAiAccess) throw new Error("No AI access");
  },
}));
vi.mock("@/utils/llms/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: () => ({}),
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => mocks.generateObject,
}));

import {
  INTERPRET_SEARCH_TIMEOUT_MS,
  interpretSearch,
} from "@/utils/ai/mail-search/interpret-search";

const logger = createScopedLogger("interpret-search-test");
const NOW = new Date("2026-10-19T16:00:00Z");

function provider(
  name: "google" | "microsoft",
  getLabels: () => Promise<{ name: string }[]> = async () => [
    { name: "Receipts" },
  ],
) {
  return { name, getLabels } as unknown as EmailProvider;
}

function interpret(emailProvider = provider("google")) {
  return interpretSearch({
    emailAccountId: "account-1",
    query: "the lease contract Sarah sent last month",
    emailProvider,
    logger,
    now: NOW,
  });
}

beforeEach(() => {
  mocks.hasAiAccess = true;
  mocks.generateObject.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("interpretSearch", () => {
  it("makes no model call without AI access", async () => {
    mocks.hasAiAccess = false;
    await expect(interpret()).resolves.toBeNull();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("returns only searches Cue can run, at most three, without repeats", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        searches: [
          "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
          "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
          "in:trash larger:10M",
          "label:receipts label:invented lease",
          "from:sarah lease",
          "from:sarah contract",
        ],
        explanation: " Mail from Sarah with attachments in September ",
        isQuestion: false,
      },
    });

    await expect(interpret()).resolves.toEqual({
      searches: [
        "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
        "label:Receipts lease",
        "from:sarah lease",
      ],
      explanation: "Mail from Sarah with attachments in September",
      isQuestion: false,
    });
  });

  it("writes searches in Outlook's syntax for an Outlook account", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        searches: ["from:sarah has:attachment after:2026/09/01 lease"],
        explanation: "Mail from Sarah",
        isQuestion: false,
      },
    });

    const intent = await interpret(provider("microsoft"));
    expect(intent?.searches).toEqual([
      "from:sarah hasattachments:true received>=2026-09-01 lease",
    ]);
  });

  it("keeps the search but drops labels when they can't be loaded", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        searches: ["label:receipts amazon"],
        explanation: "Amazon receipts",
        isQuestion: false,
      },
    });

    const intent = await interpret(
      provider("google", async () => {
        throw new Error("Labels unavailable");
      }),
    );
    expect(intent?.searches).toEqual(["amazon"]);
  });

  it("gives up at the time budget when the model doesn't answer", async () => {
    vi.useFakeTimers();
    mocks.generateObject.mockReturnValue(new Promise(() => undefined));

    const result = interpret();
    await vi.advanceTimersByTimeAsync(INTERPRET_SEARCH_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("returns null when the model call fails", async () => {
    mocks.generateObject.mockRejectedValue(new Error("Model unavailable"));
    await expect(interpret()).resolves.toBeNull();
  });
});
