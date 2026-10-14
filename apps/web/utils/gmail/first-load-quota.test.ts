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
import { GMAIL_USER_UNITS_PER_MINUTE } from "@/utils/gmail/quota";
import { getHomeData } from "@/utils/home/get-home";
import prisma from "@/utils/prisma";

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
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis", () => ({ redis: memory.redis }));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [] }),
}));
vi.mock("@/utils/thread-context/connector-context", () => ({
  fetchConnectorCandidates: async () => [],
}));
vi.mock("@/utils/thread-context/linked-pages", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLinkedPages: async () => [],
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
    const gmail = createFakeGmail({
      unitsPerMinute: GMAIL_USER_UNITS_PER_MINUTE,
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
    const rateLimitModes: Array<{ at: number; source: string }> = [];
    const threadOpens: Array<{ at: number; ms: number; ok: boolean }> = [];

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
    const running = () => Date.now() - start < END_MS;

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
        else if (result.value.status === "ok")
          page = result.value.value.nextPage;
        else if (result.value.status === "paused")
          await sleep(result.value.retryAfterMs);
        else await sleep(1000);
      }
    };

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
          loadEmails(
            { emailAccountId: ACCOUNT, emailProvider: provider, logger },
            { loadBefore: false },
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
});
