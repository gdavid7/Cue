import { describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { searchContext } from "./search-context";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(async () => ({ events: [] })),
}));

const USER = "david@example.com";
const NOW = new Date("2026-10-13T16:00:00Z");

describe("searchContext", () => {
  it("follows an organization named in the query to its people's other threads", async () => {
    const renewal = thread("renewal", {
      from: "Sarah Chen <sarah@acme.com>",
      subject: "Acme renewal",
      snippet: "Can you send pricing?",
    });
    // Never mentions Acme, but it's with Acme's buyer.
    const invoice = thread("invoice", {
      from: "Sarah Chen <sarah@acme.com>",
      subject: "Invoice question",
      snippet: "Which PO number should we use?",
    });
    const provider = {
      searchThreads: vi.fn(async () => ({ threads: [renewal] })),
      getThreadsWithParticipant: vi.fn(async () => [renewal, invoice]),
    } as unknown as EmailProvider;

    const { results } = await searchContext({
      emailAccountId: "account-1",
      userEmail: USER,
      query: "acme",
      emailProvider: provider,
      logger: createTestLogger(),
      now: NOW,
    });

    expect(results.map((r) => r.id)).toEqual(
      expect.arrayContaining(["renewal", "invoice"]),
    );
    expect(results.find((r) => r.id === "invoice")).toMatchObject({
      messageId: "invoice-msg",
      why: expect.arrayContaining(["With Sarah Chen"]),
    });
    expect(provider.getThreadsWithParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ participantEmail: "sarah@acme.com" }),
    );
  });

  it("doesn't follow people the query doesn't name", async () => {
    const provider = {
      searchThreads: vi.fn(async () => ({
        threads: [
          thread("t1", {
            from: "Alex Kim <alex@ctc.com>",
            subject: "Superday schedule",
            snippet: "Your superday is Thursday",
          }),
        ],
      })),
      getThreadsWithParticipant: vi.fn(async () => []),
    } as unknown as EmailProvider;

    const { results } = await searchContext({
      emailAccountId: "account-1",
      userEmail: USER,
      query: "superday",
      emailProvider: provider,
      logger: createTestLogger(),
      now: NOW,
    });

    expect(results.map((r) => r.id)).toEqual(["t1"]);
    expect(provider.getThreadsWithParticipant).not.toHaveBeenCalled();
  });

  it("reports a mailbox Gmail is limiting instead of finding nothing", async () => {
    const deferred = new GmailCallDeferredError(12_000, "interactive");
    const provider = {
      name: "google",
      searchThreads: vi.fn(async () => {
        throw deferred;
      }),
      getThreadsWithParticipant: vi.fn(async () => []),
    } as unknown as EmailProvider;

    await expect(
      searchContext({
        emailAccountId: "account-1",
        userEmail: USER,
        query: "acme",
        emailProvider: provider,
        logger: createTestLogger(),
        now: NOW,
      }),
    ).rejects.toBe(deferred);
  });

  it("still answers from the calendar and apps when the mail search breaks", async () => {
    const provider = {
      name: "google",
      searchThreads: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      getThreadsWithParticipant: vi.fn(async () => []),
    } as unknown as EmailProvider;

    await expect(
      searchContext({
        emailAccountId: "account-1",
        userEmail: USER,
        query: "acme",
        emailProvider: provider,
        logger: createTestLogger(),
        now: NOW,
      }),
    ).resolves.toEqual({ results: [] });
  });
});

function thread(
  id: string,
  {
    from,
    subject,
    snippet,
  }: { from: string; subject: string; snippet: string },
): EmailThread {
  return {
    id,
    snippet,
    messages: [
      {
        ...getMockMessage({
          id: `${id}-msg`,
          threadId: id,
          from,
          to: USER,
          subject,
          snippet,
          textPlain: snippet,
        }),
        internalDate: String(NOW.getTime() - 86_400_000),
      },
    ],
  };
}
