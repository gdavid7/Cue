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
const epoch = (iso: string) => String(Date.parse(iso) / 1000);

function reading(overrides: Record<string, unknown> = {}) {
  return {
    senders: ["sarah"],
    recipients: [],
    sentByUser: false,
    keywordGroups: [["lease", "contract"]],
    hasAttachment: true,
    unread: false,
    starred: false,
    label: "receipts",
    dateRange: "last_month",
    lastNDays: 0,
    fromDate: "",
    toDate: "",
    explanation: " Mail from Sarah with attachments last month ",
    isQuestion: false,
    ...overrides,
  };
}

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

  it("builds the search from the model's reading, dates in the account's time zone", async () => {
    mocks.generateObject.mockResolvedValue({ object: reading() });

    await expect(interpret()).resolves.toEqual({
      searches: [
        `from:sarah (lease OR contract) has:attachment label:Receipts after:${epoch("2026-09-01T07:00:00Z")} before:${epoch("2026-10-01T07:00:00Z")}`,
      ],
      editableSearches: [
        "from:sarah (lease OR contract) has:attachment label:Receipts after:2026/09/01 before:2026/10/01",
      ],
      unreadOnly: false,
      explanation: "Mail from Sarah with attachments last month",
      isQuestion: false,
    });
  });

  it("writes the search in Outlook's syntax for an Outlook account", async () => {
    mocks.generateObject.mockResolvedValue({ object: reading() });

    const intent = await interpret(provider("microsoft"));
    expect(intent?.searches).toEqual([
      "from:sarah (lease OR contract) hasattachments:true category:Receipts received>=2026-09-01 received<2026-10-01",
    ]);
  });

  it("leaves unread out of an Outlook search and asks Cue to apply it", async () => {
    mocks.generateObject.mockResolvedValue({
      object: reading({ unread: true, dateRange: "none", label: "" }),
    });

    const outlook = await interpret(provider("microsoft"));
    expect(outlook?.searches).toEqual([
      "from:sarah (lease OR contract) hasattachments:true",
    ]);
    expect(outlook?.unreadOnly).toBe(true);

    const gmail = await interpret();
    expect(gmail?.searches).toEqual([
      "from:sarah (lease OR contract) has:attachment is:unread",
    ]);
    expect(gmail?.unreadOnly).toBe(false);
  });

  it("keeps the search but drops the label when labels can't be loaded", async () => {
    mocks.generateObject.mockResolvedValue({
      object: reading({ dateRange: "none" }),
    });

    const intent = await interpret(
      provider("google", async () => {
        throw new Error("Labels unavailable");
      }),
    );
    expect(intent?.searches).toEqual([
      "from:sarah (lease OR contract) has:attachment",
    ]);
  });

  it("logs a failed reading without the model's output", async () => {
    const warn = vi.spyOn(logger, "warn");
    const error = new Error('Type validation failed: {"senders":["secret"]}');
    error.name = "AI_TypeValidationError";
    mocks.generateObject.mockRejectedValue(error);

    await expect(interpret()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("Search interpretation failed", {
      timedOut: false,
      errorName: "AI_TypeValidationError",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
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
