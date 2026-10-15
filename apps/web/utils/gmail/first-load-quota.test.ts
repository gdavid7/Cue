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
  isDraftRepliesEnabled: () => true,
}));
// Only the shared Gmail quota gate paces Gmail here: the engine's own
// envelope admits everything, so the bound below cannot come from it.
vi.mock("@/utils/email/local-mail-sync-budget", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withLocalMailSyncBudget: (
    _input: unknown,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) => operation(new AbortController().signal),
}));

const ACCOUNT = "account-1";
const logger = createScopedLogger("first-load-quota-test");
const END_MS = 240_000;
const STEADY_MS = 180_000;
// The gate refills 3,600 units a minute; a thread open costs 40 units, so one
// every 0.7 s spends 95% of that.
const BUCKET_UNITS_PER_SECOND = 60;
const OPEN_EVERY_MS = 700;
// Gmail's per-user limit for short bursts, a moving average over a second.
const GMAIL_UNITS_PER_SECOND = 250;

// Replays what opening Cue fires at Gmail: two tabs each scanning the recent
// window and backfilling older mail, a deep-linked thread plus three more
// opened over the minute (each with its context panel, suggested reply and
// insight), inbox insights for the first rows, Today and sidebar reads, a
// stats refresh and a webhook. A fake Gmail charges each call its documented
// cost and refuses calls past 6,000 units in any rolling minute, as Gmail does.
describe("Gmail quota on a first load", () => {
  let start = 0;

  beforeEach(() => {
    vi.useFakeTimers();
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

    for (let elapsed = 0; elapsed < END_MS + 60_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await actors;

    expect(gmail.limitedCalls()).toEqual([]);
    expect(rateLimitModes).toEqual([]);
    // 80% of Gmail's limit leaves room for estimation error and for clients
    // of the same Google project outside this account's budget.
    expect(gmail.peakMinuteUnits()).toBeLessThanOrEqual(
      GMAIL_USER_UNITS_PER_MINUTE * 0.8,
    );
    // Opening a thread never waits on sync or analysis: each read is served
    // within the fake's single round trip.
    expect(threadOpens).toEqual(
      [1000, 15_000, 30_000, 45_000].map((at) => ({ at, ms: 250, ok: true })),
    );
    // Today waits for its share rather than showing lanes emptied by quota.
    expect(home).toMatchObject({
      ok: true,
      value: { handled: expect.arrayContaining([expect.anything()]) },
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
    expect(gmail.peakSecondUnits()).toBeLessThanOrEqual(GMAIL_UNITS_PER_SECOND);
    // The search waits at most a moment behind the sync, never the turn.
    expect(search).toMatchObject({ ok: true });
    expect(search?.ms).toBeLessThan(3000);
    expect(chat.deferred).toBe(0);
    // The first sync still finishes its recent window within the minute.
    expect(
      gmail.unitsByCaller(start, start + 60_000)["mail/v1/enumeration"],
    ).toBeGreaterThan(2000);
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
      BUCKET_UNITS_PER_SECOND - 40_000 / OPEN_EVERY_MS;
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
 * A fake Gmail that charges documented costs, wired under the real Gmail
 * client and provider, and the actors a replay is built from: a route that
 * records rate-limit mode, an SWR-style retry, and a tab's engine scope.
 */
async function startReplay(
  endMs: number,
  { unitsPerSecond }: { unitsPerSecond?: number } = {},
) {
  const start = Date.now();
  const rateLimitModes: Array<{ at: number; source: string }> = [];
  const gmail = createFakeGmail({
    unitsPerMinute: GMAIL_USER_UNITS_PER_MINUTE,
    unitsPerSecond,
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
  const engineScope = async (tab: string, scopeId: string) => {
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
      else if (result.value.status === "ok") page = result.value.value.nextPage;
      else if (result.value.status === "paused")
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
