import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { auth as gmailAuth } from "@googleapis/gmail";
import { createFakeGmail } from "@/__tests__/mocks/fake-gmail-quota";
import { runWithAuditContext } from "@/utils/audit/context";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { GmailProvider } from "@/utils/email/google";
import {
  assertProviderNotRateLimited,
  recordProviderRateLimitFromError,
} from "@/utils/email/rate-limit";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";
import { getThreadContext } from "@/utils/thread-context/get-thread-context";
import { suggestReply } from "@/utils/thread-context/suggest-reply";
import { getInboxInsights } from "@/utils/inbox-insights/get-inbox-insights";
import { loadEmails } from "@/utils/actions/stats-loading";
import { createScopedLogger } from "@/utils/logger";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import {
  createGmailQuotaStats,
  GMAIL_USER_UNITS_PER_MINUTE,
  resetGmailQuotaInstanceState,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { CHAT_TOOL_GMAIL_WAIT_BUDGET_MS } from "@/utils/ai/assistant/chat-tool-runtime";
import { getHomeData } from "@/utils/home/get-home";
import prisma from "@/utils/prisma";
import { bulkArchiveAction } from "@/utils/actions/mail-bulk-action";
import { createEmailProvider } from "@/utils/email/provider";

const memory = vi.hoisted(() => {
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    values,
    redis: {
      get: async (key: string) => read(key),
      set: async (
        key: string,
        value: unknown,
        options?: { ex?: number; px?: number },
      ) => {
        const ttl = options?.px ?? (options?.ex ? options.ex * 1000 : 1e12);
        values.set(key, { value, expiresAt: Date.now() + ttl });
        return "OK";
      },
      del: async (key: string) => (values.delete(key) ? 1 : 0),
      mget: async (...keys: string[]) => keys.map(read),
      pipeline: () => {
        const writes: Array<[string, unknown, number]> = [];
        const pipeline = {
          set: (key: string, value: unknown, options?: { ex?: number }) => {
            writes.push([key, value, (options?.ex ?? 1e9) * 1000]);
            return pipeline;
          },
          exec: async () => {
            for (const [key, value, ttl] of writes)
              values.set(key, { value, expiresAt: Date.now() + ttl });
            return writes.map(() => "OK");
          },
        };
        return pipeline;
      },
    },
  };
});

vi.mock("@/utils/prisma");
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: () => undefined,
}));
vi.mock("@/utils/auth", () => ({
  auth: async () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));
vi.mock("@/utils/email/provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis", () => ({ redis: memory.redis }));
// Today's Next up reads the calendar and connected apps, not Gmail.
vi.mock("@/utils/home/next-up", () => ({
  getNextUp: async () => ({
    calendar: { connected: false, next: null },
    nextUp: [],
    suggestion: null,
  }),
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [], complete: true }),
}));
vi.mock("@/utils/thread-context/connector-context", () => ({
  fetchConnectorCandidates: async () => ({ candidates: [], complete: true }),
}));
vi.mock("@/utils/thread-context/linked-pages", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLinkedPages: async () => ({ candidates: [], complete: true }),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => null,
}));
vi.mock("@/utils/rule/draft-replies-enabled", () => ({
  getDraftRepliesSetting: () => "on",
  canWriteRequestedReplies: () => true,
}));
// Only the shared Gmail quota gate paces Gmail here: the engine's own
// envelope admits everything, so the bound below cannot come from it.
vi.mock("@/utils/email/local-mail-sync-budget", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withLocalMailSyncBudget: (
    _input: unknown,
    operation: (
      signal: AbortSignal,
      admission: { nextAdmitAfterMs: number | null },
    ) => Promise<unknown>,
  ) => operation(new AbortController().signal, { nextAdmitAfterMs: null }),
}));

const ACCOUNT = "account-1";
const logger = createScopedLogger("first-load-quota-test");
const END_MS = 240_000;
const STEADY_MS = 180_000;
// The gate refills at the account's budget, 12,000 units a minute to start;
// a thread open reads it in full, 120 units, so one every 0.7 s spends 86%
// of that.
const BUCKET_UNITS_PER_SECOND = (GMAIL_USER_UNITS_PER_MINUTE * 0.8) / 60;
const THREAD_OPEN_UNITS = 120;
const OPEN_EVERY_MS = 700;
// Gmail's limit is a moving average that allows short bursts. Google
// publishes no burst size, so the fake refuses any second past four times
// the minute spread evenly, and the gate keeps under that.
const GMAIL_UNITS_PER_SECOND = (GMAIL_USER_UNITS_PER_MINUTE / 60) * 4;
const GATE_UNITS_PER_SECOND = 700;
const HOME_BUDGET_MS = 10_000;

// Replays what opening Cue fires at Gmail: two tabs each scanning the recent
// window and backfilling older mail, a deep-linked thread plus three more
// opened over the minute (each with its context panel, suggested reply and
// insight), inbox insights for the first rows, Today and sidebar reads, a
// stats refresh and a webhook. A fake Gmail charges each call its modelled
// cost and refuses calls past the per-user limit in any rolling minute.
describe("Gmail quota on a first load", () => {
  let start = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    resetGmailQuotaInstanceState();
    start = Date.now();
    memory.values.clear();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays within Gmail's per-user minute while thread opens stay immediate", async () => {
    const {
      gmail,
      client,
      provider,
      route,
      retried,
      engineScope,
      sleep,
      rateLimitModes,
    } = await startReplay(END_MS);
    const threadOpens: Array<{ at: number; ms: number; ok: boolean }> = [];

    const openThread = async (threadId: string) => {
      const source = createEmailProviderMailboxSource({
        provider,
        accountId: ACCOUNT,
        logger,
      });
      const context = {
        session: { accountId: ACCOUNT, generation: "gen-a" },
        requestId: `open-${threadId}`,
        signal: new AbortController().signal,
      };
      const openedAt = Date.now();
      await Promise.all([
        route("mail/v1/conversation-membership", () =>
          source.readConversationMembership({
            ...context,
            conversation: { accountId: ACCOUNT, conversationId: threadId },
            resolutionId: "r",
            page: null,
            pageSize: 50,
          }),
        ).then((result) =>
          threadOpens.push({
            at: openedAt - start,
            ms: Date.now() - openedAt,
            ok: result.ok && result.value.status === "ok",
          }),
        ),
        route("mail/v1/hydration", () =>
          source.hydrate({
            ...context,
            keys: [{ accountId: ACCOUNT, messageId: `m${threadId.slice(1)}` }],
            purpose: "body",
          }),
        ),
        retried("user/thread-context", () =>
          getThreadContext({
            emailAccountId: ACCOUNT,
            userEmail: "me@example.com",
            threadId,
            emailProvider: provider,
            logger,
          }),
        ),
        retried("user/suggested-reply", () =>
          suggestReply({
            emailAccountId: ACCOUNT,
            userEmail: "me@example.com",
            threadId,
            emailProvider: provider,
            logger,
          }),
        ),
        insights([{ threadId, messageId: `m${threadId.slice(1)}` }]),
      ]);
    };

    const insights = (items: { threadId: string; messageId: string }[]) =>
      retried("user/inbox-insights", () =>
        getInboxInsights({
          emailAccountId: ACCOUNT,
          userId: "user-1",
          userEmail: "me@example.com",
          items,
          emailProvider: provider,
          logger,
        }),
      );
    const rows = (from: number) =>
      Array.from({ length: 50 }, (_, i) => ({
        threadId: `t${from + i}`,
        messageId: `m${from + i}`,
      }));
    const at = (ms: number, run: () => Promise<unknown>) => sleep(ms).then(run);

    // Today lists Cue's reply trackers, which live in the database.
    vi.mocked(prisma.threadTracker.findMany).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        threadId: `t${30 + i}`,
      })) as never,
    );
    for (const findMany of [
      prisma.executedAction.findMany,
      prisma.scheduledAction.findMany,
      prisma.executedRule.findMany,
    ])
      vi.mocked(findMany).mockResolvedValue([]);
    // Today's activity summary counts the messages Cue checked today.
    vi.mocked(prisma.executedRule.groupBy).mockResolvedValue([] as never);
    let home: unknown = null;
    const actors = Promise.all([
      engineScope("a", "primary"),
      engineScope("a", "history"),
      engineScope("b", "primary"),
      engineScope("b", "history"),
      at(1000, () => openThread("t1")),
      at(1500, () => insights(rows(0))),
      at(1200, () =>
        retried("user/home", () =>
          getHomeData({
            emailAccountId: ACCOUNT,
            userEmail: "me@example.com",
            emailProvider: provider,
            logger,
          }),
        ).then((result) => {
          home = result;
        }),
      ),
      at(1500, () => route("user/labels", () => provider.getLabels())),
      at(2000, () =>
        retried("loadEmailStats", () =>
          // The stats action declares its Gmail calls background.
          runWithGmailQuota({ priority: "background" }, () =>
            loadEmails(
              { emailAccountId: ACCOUNT, emailProvider: provider, logger },
              { loadBefore: false },
            ),
          ),
        ),
      ),
      at(5000, () =>
        route("google/webhook", async () => {
          await client.users.history.list({
            userId: "me",
            startHistoryId: "1",
          });
          await provider.getMessage("m0");
          await provider.getMessage("m1");
        }),
      ),
      at(8000, () => insights(rows(50))),
      at(15_000, () => openThread("t7")),
      at(30_000, () => openThread("t12")),
      at(45_000, () => openThread("t20")),
    ]);

    await advanceUntilSettled(actors, END_MS + 60_000);

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    // Any minute carries at most the account's budget, 80% of Gmail's limit,
    // and the bucket's 2,000 units saved before it, which leaves the rest of
    // the limit for estimation error and for the project's other clients.
    expect(gmail.peakMinuteUnits()).toBeLessThanOrEqual(
      GMAIL_USER_UNITS_PER_MINUTE * 0.8 + 2000,
    );
    // Opening a thread never waits on sync or analysis: each read is served
    // within the fake's single round trip.
    expect(threadOpens).toEqual(
      [1000, 15_000, 30_000, 45_000].map((at) => ({ at, ms: 250, ok: true })),
    );
    // Today waits for its share rather than showing lanes emptied by quota.
    expect(home).toMatchObject({
      ok: true,
      value: {
        needsYou: expect.arrayContaining([expect.anything()]),
        alsoInInbox: expect.arrayContaining([expect.anything()]),
        pending: [],
      },
    });
    // Background work still gets done once the inbox has filled.
    expect(gmail.unitsByCaller(start, start + END_MS)).toMatchObject({
      "user/thread-context": expect.any(Number),
      "user/inbox-insights": expect.any(Number),
    });
  }, 60_000);

  // Replays the founder's first minute in production (06:09): Gmail refused
  // the tail of each first-sync batch and then the assistant's searches,
  // although the gate had admitted only about 3,300 of 6,000 units that
  // minute. Gmail also limits short bursts; a 25-message batch is 500 units
  // in one instant.
  it("never bursts past Gmail's per-second limit during a first sync, and a chat search mid-sync gets through", async () => {
    const { gmail, provider, route, engineScope, sleep, rateLimitModes } =
      await startReplay(STEADY_MS, { unitsPerSecond: GMAIL_UNITS_PER_SECOND });
    const chat = createGmailQuotaStats();
    let search: { ok: boolean; ms: number } | null = null;
    const actors = Promise.all([
      engineScope("a", "primary"),
      engineScope("a", "history"),
      sleep(2000).then(async () => {
        const askedAt = Date.now();
        const result = await route("chat/searchInbox", () =>
          runWithGmailQuota(
            {
              caller: "chat/searchInbox",
              priority: "interactive",
              stats: chat,
              maxTotalWaitMs: CHAT_TOOL_GMAIL_WAIT_BUDGET_MS,
            },
            () =>
              provider.getMessagesWithPagination({
                query: "from:registrar@example.com",
                maxResults: 20,
              }),
          ),
        );
        search = { ok: result.ok, ms: Date.now() - askedAt };
      }),
    ]);

    for (let elapsed = 0; elapsed < STEADY_MS + 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await actors;

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    expect(gmail.peakSecondUnits()).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
    // The search waits at most a moment behind the sync, never the turn.
    expect(search).toMatchObject({ ok: true });
    expect(search?.ms).toBeLessThan(3000);
    expect(chat.deferred).toBe(0);
    // The first sync still finishes its recent window within the minute.
    expect(
      gmail.unitsByCaller(start, start + 60_000)["mail/v1/enumeration"],
    ).toBeGreaterThan(2000);
  }, 60_000);

  // The inbox's first page is one interactive request for 25 messages'
  // metadata: about 505 units, which the bucket's floor under sync covers.
  it("serves a first inbox page within the per-second cap's time while a first sync runs", async () => {
    const { gmail, provider, route, engineScope, sleep, rateLimitModes } =
      await startReplay(STEADY_MS, { unitsPerSecond: GMAIL_UNITS_PER_SECOND });
    let firstPage: { ok: boolean; ms: number; count: number } | null = null;
    const actors = Promise.all([
      engineScope("a", "primary"),
      engineScope("a", "history"),
      // Five seconds in, the sync has filled the second with its share.
      sleep(5000).then(async () => {
        const askedAt = Date.now();
        const result = await route("threads", () =>
          runWithGmailQuota({ priority: "interactive" }, () =>
            provider.getMessagesWithPagination({
              maxResults: 25,
              format: "metadata",
            }),
          ),
        );
        firstPage = {
          ok: result.ok,
          ms: Date.now() - askedAt,
          count: result.ok ? result.value.messages.length : 0,
        };
      }),
    ]);

    for (let elapsed = 0; elapsed < STEADY_MS + 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await actors;

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    expect(gmail.peakSecondUnits()).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
    expect(firstPage).toMatchObject({ ok: true, count: 25 });
    expect(firstPage?.ms).toBeLessThanOrEqual(2600);
  }, 60_000);

  // Right after a sign-in, the first sync's first page is the inbox someone
  // waits on, but they may open a conversation from the server's preview
  // rows before it lands. That read must not queue behind the page.
  it("serves a thread opened during a first sync's first page in one round trip", async () => {
    const { gmail, provider, route, engineScope, sleep, rateLimitModes } =
      await startReplay(30_000, { unitsPerSecond: GMAIL_UNITS_PER_SECOND });
    let openedIn: number | null = null;
    const actors = Promise.all([
      engineScope("a", "primary", { initial: true }),
      engineScope("a", "history", { initial: true }),
      // The bootstrap's reads take three round trips; the page is listed and
      // its first batches are in flight.
      sleep(1100).then(async () => {
        const openedAt = Date.now();
        const result = await route("threads/detail", () =>
          provider.getThread("t3"),
        );
        if (result.ok) openedIn = Date.now() - openedAt;
      }),
    ]);
    await advanceUntilSettled(actors, 30_000);

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    expect(
      gmail.unitsByCaller(start, start + 1200)["mail/v1/enumeration"],
    ).toBeGreaterThan(0);
    expect(openedIn).toBe(250);
  }, 60_000);

  // Production, 20:14: Today on a large mailbox ran into the route's 30 s
  // limit while the account's sync held the gate, and every SWR retry did the
  // same. Today must answer within its budget, with whatever Gmail could not
  // serve in time marked pending rather than failing the page.
  it("answers Today within its budget while two tabs' first syncs run", async () => {
    const { gmail, provider, route, engineScope, sleep, rateLimitModes } =
      await startReplay(STEADY_MS, { unitsPerSecond: GMAIL_UNITS_PER_SECOND });
    vi.mocked(prisma.threadTracker.findMany).mockImplementation((async ({
      where,
    }: {
      where: { type: string };
    }) =>
      Array.from({ length: 30 }, (_, i) => ({
        threadId: `t${(where.type === "AWAITING" ? 60 : 30) + i}`,
      }))) as never);
    for (const findMany of [
      prisma.executedAction.findMany,
      prisma.scheduledAction.findMany,
      prisma.executedRule.findMany,
    ])
      vi.mocked(findMany).mockResolvedValue([]);
    vi.mocked(prisma.executedRule.groupBy).mockResolvedValue([] as never);
    let home: { ok: boolean; ms: number; value?: unknown } | null = null;
    const actors = Promise.all([
      engineScope("a", "primary"),
      engineScope("a", "history"),
      engineScope("b", "primary"),
      engineScope("b", "history"),
      sleep(5000).then(async () => {
        const askedAt = Date.now();
        const result = await route("user/home", () =>
          getHomeData({
            emailAccountId: ACCOUNT,
            userEmail: "me@example.com",
            emailProvider: provider,
            logger,
          }),
        );
        home = {
          ok: result.ok,
          ms: Date.now() - askedAt,
          value: result.ok ? result.value : result.error,
        };
      }),
    ]);

    for (let elapsed = 0; elapsed < STEADY_MS + 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await actors;

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    // Before the fix: deferred after 15.7 s, failing the whole page.
    expect(home).toMatchObject({ ok: true });
    expect(home!.ms).toBeLessThanOrEqual(HOME_BUDGET_MS);
    // Today's reads go ahead of the sync. Its thirty thread reads (about
    // 1,200 units) may outrun what sync leaves of the bucket while two tabs
    // sync, so the first lanes land and any rest come back pending, never
    // empty.
    expect(home!.value).toMatchObject({
      needsYou: expect.arrayContaining([expect.anything()]),
    });
    expectServedOrPending(
      home!.value as Parameters<typeof expectServedOrPending>[0],
    );
  }, 60_000);

  // A person opens threads while the first sync fills the inbox and inbox
  // insights read in the background. Opening a thread must not slow the very
  // scan that fills in its older messages (seen in emulated QA: the reader
  // showed a reply thread without its original, still on page two).
  it("keeps the first sync filling the inbox while someone opens threads", async () => {
    // A small mailbox, as in the emulated QA account: the recent window is
    // two pages read in full, about 2,410 units.
    const { gmail, provider, route, retried, engineScope, sleep } =
      await startReplay(STEADY_MS, {
        unitsPerSecond: GMAIL_UNITS_PER_SECOND,
        recentCount: 40,
      });
    const opens: number[] = [];
    // A second in, the person opens a thread whose original is on page two:
    // a few reads of its messages.
    const reader = async () => {
      await sleep(1000);
      for (let i = 0; i < 3; i++) {
        await sleep(300);
        const openedAt = Date.now();
        const result = await route("threads/detail", () =>
          provider.getThread(`t${i}`),
        );
        if (result.ok) opens.push(Date.now() - openedAt);
      }
    };
    const insights = sleep(1500).then(() =>
      retried("user/inbox-insights", () =>
        getInboxInsights({
          emailAccountId: ACCOUNT,
          userId: "user-1",
          userEmail: "me@example.com",
          items: Array.from({ length: 25 }, (_, i) => ({
            threadId: `t${i}`,
            messageId: `m${i}`,
          })),
          emailProvider: provider,
          logger,
        }),
      ),
    );
    let recentWindowMs: number | null = null;
    const actors = Promise.all([
      engineScope("a", "primary").then(() => {
        recentWindowMs = Date.now() - start;
      }),
      engineScope("a", "history"),
      reader(),
      insights,
    ]);
    await advanceUntilSettled(actors, STEADY_MS + 60_000);

    expect(gmail.limitedCalls()).toEqual([]);
    expect(gmail.peakSecondUnits()).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
    expect(opens).toHaveLength(3);
    // About 2,410 units: what sync may spend of the bucket, then the rest at
    // a 12,000-unit budget's refill, around the thread's reads.
    expect(recentWindowMs).not.toBeNull();
    expect(recentWindowMs).toBeLessThanOrEqual(12_000);
  }, 60_000);

  // A fresh device: the recent scan is quick, then the backfill brings the
  // inbox's older rows. A quarter of the backfill window is still in the
  // inbox; the rest is archived mail of the same weeks, which the inbox
  // never shows. The engine's own envelope is not modelled here, so the
  // bound comes from the gate alone.
  it("brings a first sync's older inbox rows first, inside the account's caps, while thread opens stay immediate", async () => {
    const { gmail, provider, route, retried, engineScope, sleep } =
      await startReplay(STEADY_MS, {
        unitsPerSecond: GMAIL_UNITS_PER_SECOND,
        recentCount: 40,
        inboxEvery: 4,
      });
    const olderInboxAt: number[] = [];
    const onPage = (messageIds: string[]) => {
      for (const id of messageIds) {
        const i = Number(id.slice(1));
        if (i >= 40 && (i - 40) % 4 === 0)
          olderInboxAt.push(Date.now() - start);
      }
    };
    const opens: number[] = [];
    const reader = async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(5000);
        const openedAt = Date.now();
        const result = await route("threads/detail", () =>
          provider.getThread(`t${i}`),
        );
        if (result.ok) opens.push(Date.now() - openedAt);
      }
    };
    const insights = sleep(1500).then(() =>
      retried("user/inbox-insights", () =>
        getInboxInsights({
          emailAccountId: ACCOUNT,
          userId: "user-1",
          userEmail: "me@example.com",
          items: Array.from({ length: 25 }, (_, i) => ({
            threadId: `t${i}`,
            messageId: `m${i}`,
          })),
          emailProvider: provider,
          logger,
        }),
      ),
    );
    const firstSync = { initial: true, windowedBackfill: true };
    const actors = Promise.all([
      engineScope("a", "primary", firstSync),
      engineScope("a", "history", { ...firstSync, onPage }),
      reader(),
      insights,
    ]);
    await advanceUntilSettled(actors, STEADY_MS + 60_000);

    const olderInboxRowMs = (count: number) => olderInboxAt[count - 1];
    logger.info("Older inbox rows of a first sync", {
      first: olderInboxRowMs(1),
      hundredth: olderInboxRowMs(100),
      twoHundredth: olderInboxRowMs(200),
      byMinute: [60_000, 120_000, 180_000].map(
        (ms) => olderInboxAt.filter((at) => at <= ms).length,
      ),
    });
    // The first older inbox row lands within seconds of the recent scan, and
    // two hundred of them in about the minute their 12,000 units take at the
    // account's budget. Read as background, mixed with the archived mail of
    // the same weeks, the first took 24 s and a hundred never came within
    // four minutes.
    expect(olderInboxRowMs(1)).toBeLessThanOrEqual(15_000);
    expect(olderInboxRowMs(100)).toBeLessThanOrEqual(50_000);
    expect(olderInboxRowMs(200)).toBeLessThanOrEqual(80_000);
    // It only moves the inbox's share earlier: no refusal, any minute within
    // the account's budget and the bucket saved before it, any second within
    // the gate's highest cap.
    expect(gmail.limitedCalls()).toEqual([]);
    expect(gmail.peakMinuteUnits()).toBeLessThanOrEqual(
      GMAIL_USER_UNITS_PER_MINUTE * 0.8 + 2000,
    );
    expect(gmail.peakSecondUnits()).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
    // A thread opened meanwhile is read in the fake's one round trip (D-086).
    expect(opens).toEqual(new Array(10).fill(250));
    // Background work still gets its turn once the inbox has filled.
    expect(
      gmail.unitsByCaller(start, start + STEADY_MS)["user/inbox-insights"],
    ).toBeGreaterThan(0);
  }, 60_000);

  it("keeps the backfill moving while someone opens threads at nearly the bucket's refill rate", async () => {
    const { gmail, provider, route, engineScope, sleep, rateLimitModes } =
      await startReplay(STEADY_MS);
    const source = createEmailProviderMailboxSource({
      provider,
      accountId: ACCOUNT,
      logger,
    });
    const opens: number[] = [];
    const reader = async () => {
      for (let i = 0; Date.now() - start < STEADY_MS; i++) {
        const openedAt = Date.now();
        const result = await route("mail/v1/conversation-membership", () =>
          source.readConversationMembership({
            session: { accountId: ACCOUNT, generation: "gen-a" },
            requestId: `open-${i}`,
            signal: new AbortController().signal,
            conversation: { accountId: ACCOUNT, conversationId: `t${i % 40}` },
            resolutionId: "r",
            page: null,
            pageSize: 50,
          }),
        );
        if (result.ok) opens.push(Date.now() - openedAt);
        await sleep(Math.max(0, OPEN_EVERY_MS - (Date.now() - openedAt)));
      }
    };
    const actors = Promise.all([engineScope("a", "history"), reader()]);

    for (let elapsed = 0; elapsed < STEADY_MS + 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await actors;

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    expect(opens.every((ms) => ms === 250)).toBe(true);
    // After the bucket's opening balance is spent, the backfill gets at
    // least half of the little the reader leaves. A backfill batch that
    // needs a nearly full bucket got a tenth of it.
    const spareUnitsPerSecond =
      BUCKET_UNITS_PER_SECOND - (THREAD_OPEN_UNITS * 1000) / OPEN_EVERY_MS;
    const backfill =
      gmail.unitsByCaller(start + 60_000, start + STEADY_MS)[
        "mail/v1/enumeration"
      ] ?? 0;
    expect(backfill).toBeGreaterThanOrEqual(
      (spareUnitsPerSecond * (STEADY_MS - 60_000)) / 1000 / 2,
    );
  }, 60_000);

  it("keeps webhooks flowing while a bulk sender archive runs for minutes", async () => {
    const { gmail, client, provider, route, sleep, rateLimitModes } =
      await startReplay(STEADY_MS);
    vi.mocked(createEmailProvider).mockResolvedValue(provider);
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      email: "me@example.com",
      account: { userId: "user-1", provider: "google" },
    } as never);
    // Each sender costs a search and a batch modify; 200 of them is about
    // three minutes of the account's whole budget.
    const froms = Array.from(
      { length: 200 },
      (_, i) => `sender${i}@example.com`,
    );
    const webhooks: Array<{ at: number; ms: number; ok: boolean }> = [];
    const pushes = async () => {
      for (let at = 10_000; at < STEADY_MS; at += 20_000) {
        await sleep(at - (Date.now() - start));
        const receivedAt = Date.now();
        const result = await route("google/webhook", async () => {
          await client.users.history.list({
            userId: "me",
            startHistoryId: "1",
          });
          await provider.getMessage("m0");
        });
        webhooks.push({
          at: receivedAt - start,
          ms: Date.now() - receivedAt,
          ok: result.ok,
        });
      }
    };
    let done = false;
    const actors = Promise.all([
      bulkArchiveAction(ACCOUNT, { froms }),
      pushes(),
    ]).finally(() => {
      done = true;
    });

    while (!done) await vi.advanceTimersByTimeAsync(100);
    const [archived] = await actors;

    expect(archived?.serverError).toBeUndefined();

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    // The archive keeps going on what the pushes leave.
    expect(
      gmail.unitsByCaller(start, start + STEADY_MS).bulkArchive,
    ).toBeGreaterThan(5000);
    // Every push is processed within a few seconds rather than deferred
    // until the archive is done.
    expect(webhooks.map((webhook) => webhook.ok)).toEqual(
      new Array(9).fill(true),
    );
    expect(Math.max(...webhooks.map((webhook) => webhook.ms))).toBeLessThan(
      5000,
    );
  }, 60_000);
});

/**
 * A fake Gmail that charges modelled costs, wired under the real Gmail
 * client and provider, and the actors a replay is built from: a route that
 * records rate-limit mode, an SWR-style retry, and a tab's engine scope.
 */
async function startReplay(
  endMs: number,
  {
    unitsPerSecond,
    recentCount,
    inboxEvery,
  }: {
    unitsPerSecond?: number;
    recentCount?: number;
    inboxEvery?: number;
  } = {},
) {
  const start = Date.now();
  const rateLimitModes: Array<{ at: number; source: string }> = [];
  const gmail = createFakeGmail({
    unitsPerMinute: GMAIL_USER_UNITS_PER_MINUTE,
    unitsPerSecond,
    recentCount,
    inboxEvery,
    latencyMs: 250,
  });
  const client = await getGmailClientWithRefresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    emailAccountId: ACCOUNT,
    logger,
  });
  const auth = client.context._options.auth as InstanceType<
    typeof gmailAuth.OAuth2
  >;
  auth.transporter.defaults.fetchImplementation =
    gmail.fetch as unknown as typeof fetch;
  vi.stubGlobal("fetch", gmail.fetch);
  const provider = new GmailProvider(client, logger, ACCOUNT);

  const route = async <T>(source: string, run: () => Promise<T>) =>
    runWithAuditContext({ source, emailAccountId: ACCOUNT }, async () => {
      try {
        await assertProviderNotRateLimited({
          emailAccountId: ACCOUNT,
          provider: "google",
          source,
        });
        return { ok: true as const, value: await run() };
      } catch (error) {
        const state = await recordProviderRateLimitFromError({
          error,
          emailAccountId: ACCOUNT,
          provider: "google",
          logger,
          source,
        });
        if (state) rateLimitModes.push({ at: Date.now() - start, source });
        return { ok: false as const, error };
      }
    });

  // SWR retries a failed request until it succeeds.
  const retried = async <T>(source: string, run: () => Promise<T>) => {
    for (;;) {
      const result = await route(source, run);
      if (result.ok || !running()) return result;
      await sleep(10_000);
    }
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const running = () => Date.now() - start < endMs;

  // Each tab or device runs its own engine with its own local store.
  const engineScope = async (
    tab: string,
    scopeId: string,
    {
      initial,
      windowedBackfill,
      onPage,
    }: {
      initial?: boolean;
      windowedBackfill?: boolean;
      /** Told the message ids each page brings. */
      onPage?: (messageIds: string[]) => void;
    } = {},
  ) => {
    const source = createEmailProviderMailboxSource({
      provider,
      accountId: ACCOUNT,
      logger,
    });
    const session = { accountId: ACCOUNT, generation: `gen-${tab}` };
    const context = {
      session,
      requestId: `${tab}-${scopeId}`,
      signal: new AbortController().signal,
    };
    let page: string | null = null;
    while (running() && page === null) {
      const begun = await route("mail/v1/bootstrap", () =>
        source.beginBootstrap({
          ...context,
          scope: { id: scopeId, kind: "account", folderId: null },
          afterMs: null,
          initial,
          windowedBackfill,
        }),
      );
      if (begun.ok && begun.value.status === "ok")
        page = begun.value.value.enumerationToken;
      else await sleep(15_000);
    }
    while (running() && page) {
      const result = await route("mail/v1/enumeration", () =>
        source.enumerate({
          ...context,
          bootstrapId: "mailbox",
          page: page as string,
          pageSize: 50,
        }),
      );
      if (!result.ok) await sleep(15_000);
      else if (result.value.status === "ok") {
        onPage?.(
          result.value.value.changes.flatMap((change) =>
            change.kind === "message_patch" ? [change.key.messageId] : [],
          ),
        );
        page = result.value.value.nextPage;
      } else if (result.value.status === "paused")
        await sleep(result.value.retryAfterMs);
      else await sleep(1000);
    }
  };

  return {
    gmail,
    client,
    provider,
    route,
    retried,
    engineScope,
    sleep,
    rateLimitModes,
  };
}

/**
 * Advances the fake clock through the replay, then on until every actor has
 * finished: a call made near the end can still be waiting its turn.
 */
async function advanceUntilSettled(
  actors: Promise<unknown>,
  throughMs: number,
) {
  let settled = false;
  const done = actors.finally(() => {
    settled = true;
  });
  for (
    let elapsed = 0;
    elapsed < throughMs || (!settled && elapsed < throughMs + 120_000);
    elapsed += 100
  ) {
    await vi.advanceTimersByTimeAsync(100);
  }
  await done;
}

function expectServedOrPending(home: {
  needsYou: unknown[];
  waiting: unknown[];
  alsoInInbox: unknown[];
  pending: string[];
}) {
  for (const lane of ["needsYou", "waiting", "alsoInInbox"] as const) {
    if (!home.pending.includes(lane))
      expect(home[lane], lane).toEqual(
        expect.arrayContaining([expect.anything()]),
      );
  }
}
