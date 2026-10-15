import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { redis } from "@/utils/redis";
import { fetchConnectorCandidates } from "@/utils/thread-context/connector-context";
import { fetchLinkedPages } from "@/utils/thread-context/linked-pages";
import { getThreadContext } from "./get-thread-context";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(),
}));
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
}));
vi.mock("@/utils/thread-context/connector-context", () => ({
  fetchConnectorCandidates: vi.fn(),
}));
vi.mock("@/utils/thread-context/linked-pages", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/utils/thread-context/linked-pages")
  >()),
  fetchLinkedPages: vi.fn(),
}));

const USER = "david@example.com";
const NOW = new Date("2026-10-13T16:00:00Z");

describe("getThreadContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      events: [],
      complete: true,
    });
    vi.mocked(fetchConnectorCandidates).mockResolvedValue({
      candidates: [],
      complete: true,
    });
    vi.mocked(fetchLinkedPages).mockResolvedValue({
      candidates: [],
      complete: true,
    });
  });

  it("caches a complete result for minutes, not an hour", async () => {
    await run(renewalProvider(), "renewal");

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(redis.set).mock.calls[0]!;
    expect((options as { ex: number }).ex).toBeLessThanOrEqual(10 * 60);
  });

  it("caches a result for someone with no calendar connected", async () => {
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      events: [],
      complete: false,
      noCalendarConnected: true,
    });

    await run(renewalProvider(), "renewal");

    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it("does not cache a result missing a source that failed", async () => {
    const failures: Array<[string, () => void]> = [
      [
        "mail search",
        () => {
          const provider = renewalProvider();
          vi.mocked(provider.searchThreads).mockRejectedValue(
            new Error("search down"),
          );
          return provider;
        },
      ],
      [
        "threads with a participant",
        () => {
          const provider = renewalProvider();
          vi.mocked(provider.getThreadsWithParticipant).mockRejectedValue(
            new Error("down"),
          );
          return provider;
        },
      ],
      [
        "calendar error",
        () => {
          vi.mocked(fetchCalendarEventsInWindow).mockRejectedValueOnce(
            new Error("calendar down"),
          );
          return renewalProvider();
        },
      ],
      [
        "calendar partly read",
        () => {
          vi.mocked(fetchCalendarEventsInWindow).mockResolvedValueOnce({
            events: [],
            complete: false,
          });
          return renewalProvider();
        },
      ],
      [
        "connected app",
        () => {
          vi.mocked(fetchConnectorCandidates).mockResolvedValueOnce({
            candidates: [],
            complete: false,
          });
          return renewalProvider();
        },
      ],
      [
        "linked page",
        () => {
          vi.mocked(fetchLinkedPages).mockResolvedValueOnce({
            candidates: [],
            complete: false,
          });
          return renewalProvider();
        },
      ],
    ] as never;
    for (const [source, setUp] of failures) {
      vi.mocked(redis.set).mockClear();
      const provider = setUp() as unknown as EmailProvider;

      await run(provider, "renewal");

      expect([source, vi.mocked(redis.set).mock.calls.length]).toEqual([
        source,
        0,
      ]);
    }
  });

  it("finds other conversations with the people on the thread, never the thread itself", async () => {
    const open = thread("renewal", [
      message({
        threadId: "renewal",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Renewal terms",
        textPlain: "Need your answer on renewal terms.",
      }),
    ]);
    const pricing = thread("pricing", [
      message({
        threadId: "pricing",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Pricing sheet",
        textPlain: "Attached the pricing sheet we discussed.",
      }),
    ]);
    const provider = mockProvider({
      threads: { renewal: open },
      withParticipant: { "nora@northwind.com": [open, pricing] },
    });

    const { items } = await run(provider, "renewal");

    expect(items.map((i) => i.id)).toEqual(["pricing"]);
    expect(items[0]).toMatchObject({
      kind: "email",
      reasons: [{ type: "person", label: "Nora Patel" }],
    });
  });

  it("includes meetings with those people from the connected calendar", async () => {
    const open = thread("renewal", [
      message({
        threadId: "renewal",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Renewal terms",
      }),
    ]);
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      complete: true,
      events: [
        {
          id: "evt1",
          title: "Renewal call",
          startTime: new Date("2026-10-15T17:00:00Z"),
          endTime: new Date("2026-10-15T17:30:00Z"),
          attendees: [
            { email: "nora@northwind.com", name: "Nora Patel" },
            { email: USER },
          ],
          eventUrl: "https://calendar.example/evt1",
        },
      ],
    });

    const { items } = await run(
      mockProvider({ threads: { renewal: open } }),
      "renewal",
    );

    expect(items).toContainEqual(
      expect.objectContaining({
        id: "event:evt1",
        kind: "event",
        url: "https://calendar.example/evt1",
        reasons: expect.arrayContaining([{ type: "upcoming", days: 2 }]),
      }),
    );
  });

  it("finds threads on the same topic even when no person links them", async () => {
    const open = thread("vercel", [
      message({
        threadId: "vercel",
        from: "Vercel Billing <billing@vercel.com>",
        subject: "Invoice payment failed",
        textPlain: "Please update your payment method.",
      }),
    ]);
    const figma = thread("figma", [
      message({
        threadId: "figma",
        from: "Figma Billing <billing@figma.com>",
        subject: "Payment failed for invoice INV-4432",
        textPlain: "Update your payment method.",
      }),
    ]);
    const provider = mockProvider({
      threads: { vercel: open },
      search: [open, figma],
    });

    const { items } = await run(provider, "vercel");

    expect(items.map((i) => i.id)).toEqual(["figma"]);
    expect(provider.searchThreads).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("payment") }),
    );
  });

  it("asks connected apps about every link in the thread and its latest sender, from the loaded thread", async () => {
    const open = thread("handoff", [
      message({
        id: "m1",
        threadId: "handoff",
        from: "Nora Patel <Nora@Northwind.com>",
        textHtml:
          '<p>Notes are <a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit">here</a></p>',
      }),
      message({
        id: "m2",
        threadId: "handoff",
        from: `David <${USER}>`,
        // Quotes Nora's link; it stays hers.
        textPlain:
          "Tracking it in https://acme.atlassian.net/browse/OPS-12.\n\n> Notes are in https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
        textHtml: "",
      }),
    ]);
    const provider = mockProvider({ threads: { handoff: open } });

    await run(provider, "handoff");

    expect(fetchConnectorCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        signals: {
          links: [
            {
              url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
              messageId: "m1",
            },
            {
              url: "https://acme.atlassian.net/browse/OPS-12",
              messageId: "m2",
            },
          ],
          senderEmail: "nora@northwind.com",
        },
      }),
    );
    expect(provider.getThread).toHaveBeenCalledTimes(1);
  });

  it("doesn't look up an automated sender", async () => {
    const open = thread("alert", [
      message({
        threadId: "alert",
        from: "GitHub <notifications@github.com>",
        subject: "Review requested",
      }),
    ]);

    await run(mockProvider({ threads: { alert: open } }), "alert");

    expect(fetchConnectorCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ signals: { links: [] } }),
    );
  });

  it("still returns what it found when one source fails", async () => {
    const open = thread("renewal", [
      message({
        threadId: "renewal",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Renewal terms",
      }),
    ]);
    const pricing = thread("pricing", [
      message({
        threadId: "pricing",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Pricing sheet",
      }),
    ]);
    const provider = mockProvider({
      threads: { renewal: open },
      withParticipant: { "nora@northwind.com": [pricing] },
    });
    vi.mocked(provider.searchThreads).mockRejectedValue(
      new Error("search down"),
    );

    const { items } = await run(provider, "renewal");

    expect(items.map((i) => i.id)).toEqual(["pricing"]);
  });

  it("reads Outlook's ISO internalDate instead of falling back to 1970", async () => {
    const open = thread("renewal", [
      message({
        threadId: "renewal",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Renewal terms",
      }),
    ]);
    const outlookStyle = {
      ...message({
        threadId: "pricing",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Pricing sheet",
      }),
      internalDate: "2026-10-11T09:30:00.000Z",
    };
    const provider = mockProvider({
      threads: { renewal: open },
      withParticipant: {
        "nora@northwind.com": [thread("pricing", [outlookStyle])],
      },
    });

    const { items } = await run(provider, "renewal");

    expect(items[0]?.at).toBe("2026-10-11T09:30:00.000Z");
  });

  it("still returns email context when the calendar fails", async () => {
    const open = thread("renewal", [
      message({
        threadId: "renewal",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Renewal terms",
      }),
    ]);
    const pricing = thread("pricing", [
      message({
        threadId: "pricing",
        from: "Nora Patel <nora@northwind.com>",
        subject: "Pricing sheet",
      }),
    ]);
    vi.mocked(fetchCalendarEventsInWindow).mockRejectedValue(
      new Error("calendar down"),
    );

    const { items } = await run(
      mockProvider({
        threads: { renewal: open },
        withParticipant: { "nora@northwind.com": [pricing] },
      }),
      "renewal",
    );

    expect(items.map((i) => i.id)).toEqual(["pricing"]);
  });

  it("returns nothing, rather than failing, for a thread the provider can't find", async () => {
    const provider = mockProvider({ threads: {} });
    vi.mocked(provider.getThread).mockRejectedValue(new Error("Not Found"));

    await expect(run(provider, "missing")).resolves.toEqual({ items: [] });
  });

  it("doesn't search mail for automated participants", async () => {
    const open = thread("alert", [
      message({
        threadId: "alert",
        from: "GitHub <notifications@github.com>",
        subject: "Review requested",
      }),
    ]);
    const provider = mockProvider({ threads: { alert: open } });

    await run(provider, "alert");

    expect(provider.getThreadsWithParticipant).not.toHaveBeenCalled();
  });
});

function run(emailProvider: EmailProvider, threadId: string) {
  return getThreadContext({
    emailAccountId: "account-1",
    userEmail: USER,
    threadId,
    emailProvider,
    logger: createTestLogger(),
    now: NOW,
  });
}

function renewalProvider() {
  return mockProvider({
    threads: {
      renewal: thread("renewal", [
        message({
          threadId: "renewal",
          from: "Nora Patel <nora@northwind.com>",
          subject: "Renewal terms",
        }),
      ]),
    },
    withParticipant: {
      "nora@northwind.com": [
        thread("pricing", [
          message({
            threadId: "pricing",
            from: "Nora Patel <nora@northwind.com>",
            subject: "Pricing sheet",
          }),
        ]),
      ],
    },
  });
}

function message(
  overrides: Parameters<typeof getMockMessage>[0] & { threadId: string },
) {
  return {
    ...getMockMessage({ to: USER, ...overrides }),
    internalDate: String(NOW.getTime() - 86_400_000),
  };
}

function thread(
  id: string,
  messages: ReturnType<typeof message>[],
): EmailThread {
  return { id, messages, snippet: messages[0]?.snippet ?? "" };
}

function mockProvider({
  threads,
  withParticipant = {},
  search = [],
}: {
  threads: Record<string, EmailThread>;
  withParticipant?: Record<string, EmailThread[]>;
  search?: EmailThread[];
}) {
  return {
    getThread: vi.fn(async (id: string) => threads[id]),
    getThreadsWithParticipant: vi.fn(
      async ({ participantEmail }: { participantEmail: string }) =>
        withParticipant[participantEmail] ?? [],
    ),
    searchThreads: vi.fn(async () => ({ threads: search })),
  } as unknown as EmailProvider & {
    getThread: ReturnType<typeof vi.fn>;
    getThreadsWithParticipant: ReturnType<typeof vi.fn>;
    searchThreads: ReturnType<typeof vi.fn>;
  };
}
