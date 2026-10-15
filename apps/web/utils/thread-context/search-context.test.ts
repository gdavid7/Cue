import { describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { fetchConnectorCandidates } from "@/utils/thread-context/connector-context";
import { searchContext } from "./search-context";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(async () => ({ events: [] })),
}));
vi.mock("@/utils/thread-context/connector-context", () => ({
  fetchConnectorCandidates: vi.fn(async () => ({
    candidates: [],
    complete: true,
  })),
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

  it("finds threads with every word before newer ones with just a common word", async () => {
    const match = thread("match", {
      from: "Recruiting <jobs@northwind.com>",
      subject: "Superday schedule for analysts",
      snippet: "Your analyst superday is Thursday",
    });
    // Newest-first matches for any one word: a common word fills the page.
    const noise = Array.from({ length: 15 }, (_, i) =>
      thread(`noise-${i}`, {
        from: `Sender ${i} <sender${i}@example.com>`,
        subject: `Thursday update ${i}`,
        snippet: "See you Thursday",
      }),
    );
    const provider = {
      searchThreads: vi.fn(async ({ query }: { query: string }) => ({
        threads: query.includes(" OR ") ? noise : [match],
      })),
      getThreadsWithParticipant: vi.fn(async () => []),
    } as unknown as EmailProvider;

    const { results } = await searchContext({
      emailAccountId: "account-1",
      userEmail: USER,
      query: "analyst superday thursday",
      emailProvider: provider,
      logger: createTestLogger(),
      now: NOW,
    });

    expect(results.map((r) => r.id)).toContain("match");
  });

  it("searches once when threads with every word fill the page", async () => {
    const full = Array.from({ length: 15 }, (_, i) =>
      thread(`t${i}`, {
        from: `Sender ${i} <sender${i}@example.com>`,
        subject: "Analyst superday",
        snippet: "Superday on Thursday",
      }),
    );
    const provider = {
      searchThreads: vi.fn(async () => ({ threads: full })),
      getThreadsWithParticipant: vi.fn(async () => []),
    } as unknown as EmailProvider;

    await searchContext({
      emailAccountId: "account-1",
      userEmail: USER,
      query: "analyst superday",
      emailProvider: provider,
      logger: createTestLogger(),
      now: NOW,
    });

    expect(provider.searchThreads).toHaveBeenCalledTimes(1);
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

  describe("about one thread", () => {
    const open: EmailThread = {
      id: "open",
      snippet: "",
      messages: [
        {
          ...getMockMessage({
            id: "open-msg",
            threadId: "open",
            from: "Nora Patel <Nora@Northwind.com>",
            to: USER,
            subject: "Key rotation",
            textPlain:
              "Status is in https://acme.atlassian.net/browse/OPS-12 and the notes in https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
            textHtml: "",
          }),
          internalDate: String(NOW.getTime() - 86_400_000),
        },
      ],
    };

    function provider(getThread: () => Promise<EmailThread>) {
      return {
        name: "google",
        getThread: vi.fn(getThread),
        searchThreads: vi.fn(async () => ({ threads: [] })),
        getThreadsWithParticipant: vi.fn(async () => []),
      } as unknown as EmailProvider & { getThread: ReturnType<typeof vi.fn> };
    }

    it("includes what the thread links to and its sender's record", async () => {
      vi.mocked(fetchConnectorCandidates).mockResolvedValueOnce({
        candidates: [
          {
            id: "jira:OPS-12",
            kind: "task",
            source: "Jira",
            title: "OPS-12 Rotate staging keys",
            text: "OPS-12 Rotate staging keys\nIn Progress",
            at: "2025-01-01T00:00:00.000Z",
            people: [],
            url: "https://acme.atlassian.net/browse/OPS-12",
            linkedBy: "url",
          },
          {
            id: "hubspot:501",
            kind: "contact",
            source: "HubSpot",
            title: "Nora Patel",
            text: "Nora Patel\nVP Finance · Northwind",
            at: "2025-01-01T00:00:00.000Z",
            people: [{ email: "nora@northwind.com", name: "Nora Patel" }],
            linkedBy: "sender",
          },
        ],
        complete: true,
      });
      const emailProvider = provider(async () => open);

      const { results } = await searchContext({
        emailAccountId: "account-1",
        userEmail: USER,
        query: "status",
        threadId: "open",
        emailProvider,
        logger: createTestLogger(),
        now: NOW,
      });

      expect(emailProvider.getThread).toHaveBeenCalledWith("open");
      expect(fetchConnectorCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          keywords: ["status"],
          signals: {
            links: [
              {
                url: "https://acme.atlassian.net/browse/OPS-12",
                messageId: "open-msg",
              },
              {
                url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
                messageId: "open-msg",
              },
            ],
            senderEmail: "nora@northwind.com",
          },
        }),
      );
      expect(results.map((r) => [r.id, r.kind, r.source, r.why])).toEqual(
        expect.arrayContaining([
          ["jira:OPS-12", "task", "Jira", ["Linked in this email"]],
          ["hubspot:501", "contact", "HubSpot", ["With Nora Patel"]],
        ]),
      );
    });

    it("still searches when the thread can't be loaded, logging why at warn and the error at trace", async () => {
      const failure = new Error("Requested entity was not found.");
      const emailProvider = provider(async () => {
        throw failure;
      });
      const logger = createTestLogger();
      const warn = vi.spyOn(logger, "warn");
      const trace = vi.spyOn(logger, "trace");

      await expect(
        searchContext({
          emailAccountId: "account-1",
          userEmail: USER,
          query: "status",
          threadId: "gone",
          emailProvider,
          logger,
          now: NOW,
        }),
      ).resolves.toEqual({ results: [] });
      expect(fetchConnectorCandidates).toHaveBeenLastCalledWith(
        expect.objectContaining({ signals: undefined }),
      );
      expect(warn).toHaveBeenCalledWith(
        "Failed to load thread for context search",
        { reason: "Error" },
      );
      expect(trace).toHaveBeenCalledWith(
        "Thread for context search failed to load",
        { error: failure },
      );
    });

    it("reports a mailbox Gmail is limiting rather than leaving the thread out", async () => {
      const deferred = new GmailCallDeferredError(12_000, "interactive");

      await expect(
        searchContext({
          emailAccountId: "account-1",
          userEmail: USER,
          query: "status",
          threadId: "open",
          emailProvider: provider(async () => {
            throw deferred;
          }),
          logger: createTestLogger(),
          now: NOW,
        }),
      ).rejects.toBe(deferred);
    });
  });

  it("asks connected apps about no thread when none is given", async () => {
    await searchContext({
      emailAccountId: "account-1",
      userEmail: USER,
      query: "acme",
      emailProvider: {
        searchThreads: vi.fn(async () => ({ threads: [] })),
        getThreadsWithParticipant: vi.fn(async () => []),
      } as unknown as EmailProvider,
      logger: createTestLogger(),
      now: NOW,
    });

    expect(fetchConnectorCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({ signals: undefined }),
    );
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
