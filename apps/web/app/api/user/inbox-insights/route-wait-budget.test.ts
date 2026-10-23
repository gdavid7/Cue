import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "email-account-1";

const mocks = vi.hoisted(() => ({ getMessage: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: { eval: async () => 1 } }));
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
  getEmailProviderRateLimitStateFromRedis: async () => null,
  setEmailProviderRateLimitStateInRedis: vi.fn(async () => undefined),
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [] }),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => null,
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({
    draftReplies: "off" as const,
    webLookupEnabled: false,
  }),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailProviderTestMiddleware(
    { getMessage: mocks.getMessage },
    { handleSafeErrors: true },
  );
});

import { runWithAuditContext } from "@/utils/audit/context";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import {
  isGmailCallDeferredError,
  meterGmailCall,
  resetGmailQuotaInstanceState,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { getInboxInsights } from "@/utils/inbox-insights/get-inbox-insights";
import { createScopedLogger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";
import { GET } from "./route";

// What a background request carried in production (PF-9u): 16 new emails.
const NEW_PER_REQUEST = 16;
const REQUESTS = 20;
// A full message read.
const MESSAGE_READ_UNITS = 60;
// What Gmail itself takes to answer one read.
const GMAIL_READ_MS = 250;
// The mail engine's sync reads 100 units, then pauses this long before the
// next, cycling: from enough to hold background at its floor for whole
// seconds to a little spare.
const SYNC_GAPS_MS = [400, 600, 700, 900, 1200];
const logger = createScopedLogger("inbox-insights-wait-budget-test");

// PF-9v: with sync keeping the account's Gmail budget spent, the rows' reads
// queued call after call, 26 s at p95 in production. Within a wait budget
// the request answers with what was ready and names the rest.
describe("GET /api/user/inbox-insights with the account's Gmail budget spent", () => {
  let stopSync: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetGmailQuotaInstanceState();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
    mocks.getMessage.mockImplementation((id: string) =>
      meterGmailCall(
        { emailAccountId: ACCOUNT, cost: MESSAGE_READ_UNITS },
        async () => {
          await sleep(GMAIL_READ_MS);
          return {
            id,
            headers: { from: "alice@example.com" },
            labelIds: ["INBOX"],
          };
        },
      ),
    );
    stopSync = keepSyncReading();
    await vi.advanceTimersByTimeAsync(30_000);
  });
  afterEach(async () => {
    await stopSync?.();
    vi.useRealTimers();
  });

  it("answers the rows within its wait budget, not after queueing every read", async () => {
    // What the route did before PF-9v: the same work with no wait budget.
    const before = await measure((request) =>
      runWithAuditContext({ source: "user/inbox-insights" }, () =>
        getInboxInsights({
          emailAccountId: ACCOUNT,
          userId: "user-1",
          userEmail: "user@example.com",
          items: items(`before-${request}`),
          emailProvider: { getMessage: mocks.getMessage } as never,
          logger,
        }),
      ),
    );
    const after = await measure(async (request) => {
      const response = await runWithAuditContext(
        { source: "user/inbox-insights" },
        () => get(items(`after-${request}`)),
      );
      expect(response.status).toBe(200);
      return response.json();
    });

    console.info(
      `PF-9v saturated limiter, ${REQUESTS} background requests of ${NEW_PER_REQUEST} new: ` +
        `before ${describeRun(before)}; after ${describeRun(after)}`,
    );
    expect(percentile(before.durations, 95)).toBeGreaterThan(12_000);
    expect(percentile(after.durations, 95)).toBeLessThan(
      percentile(before.durations, 95) / 2,
    );
    // Shorter requests, not fewer emails: the budget only moves the waiting
    // from inside a request to the browser's next one.
    expect(after.built / after.elapsedMs).toBeGreaterThan(
      (0.8 * before.built) / before.elapsedMs,
    );
    // Every email sent is either answered or named for the next request.
    expect(after.built + after.left).toBe(
      (REQUESTS - after.wholeDeferrals) * NEW_PER_REQUEST,
    );
    expect(after.built).toBeGreaterThan(0);
  });
});

async function measure(
  run: (request: number) => Promise<{
    insights: Record<string, unknown>;
    deferred?: { messageIds: string[] } | null;
  }>,
) {
  const result = {
    durations: [] as number[],
    built: 0,
    left: 0,
    wholeDeferrals: 0,
    elapsedMs: 0,
  };
  const startedAt = Date.now();
  for (let request = 0; request < REQUESTS; request++) {
    const requestStartedAt = Date.now();
    let settled = false;
    // The real middleware answers a whole-request deferral with 503 and its
    // Retry-After; this test's stand-in rethrows it.
    const done = run(request)
      .then(
        (body) => {
          result.built += Object.keys(body.insights).length;
          result.left += body.deferred?.messageIds.length ?? 0;
        },
        (error: unknown) => {
          if (!isGmailCallDeferredError(error)) throw error;
          result.wholeDeferrals += 1;
        },
      )
      .finally(() => {
        settled = true;
      });
    while (!settled) await vi.advanceTimersByTimeAsync(50);
    await done;
    result.durations.push(Date.now() - requestStartedAt);
  }
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

function describeRun(run: Awaited<ReturnType<typeof measure>>) {
  return (
    `p50 ${percentile(run.durations, 50)} ms, p95 ${percentile(run.durations, 95)} ms, ` +
    `max ${Math.max(...run.durations)} ms, built ${run.built}, left ${run.left}, ` +
    `503s ${run.wholeDeferrals}, ${Math.round((run.built / run.elapsedMs) * 60_000)} built/min`
  );
}

function keepSyncReading() {
  let stop = false;
  const loop = runWithGmailQuota(
    { caller: "test/sync", priority: "sync" },
    async () => {
      for (let read = 0; !stop; read++) {
        await meterGmailCall(
          { emailAccountId: ACCOUNT, cost: 100 },
          async () => undefined,
        ).catch(() => undefined);
        await sleep(SYNC_GAPS_MS[read % SYNC_GAPS_MS.length] ?? 0);
      }
    },
  );
  return async () => {
    stop = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await loop;
  };
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? 0
  );
}

function items(prefix: string) {
  return Array.from({ length: NEW_PER_REQUEST }, (_, index) => ({
    threadId: `${prefix}-t${index}`,
    messageId: `${prefix}-m${index}`,
  }));
}

function get(list: { threadId: string; messageId: string }[]) {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/user/inbox-insights?items=${list
        .map((entry) => `${entry.threadId}:${entry.messageId}`)
        .join(",")}`,
    ),
    { params: Promise.resolve({}) },
  );
}
