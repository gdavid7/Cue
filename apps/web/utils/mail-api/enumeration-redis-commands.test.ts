import type { auth as gmailAuth } from "@googleapis/gmail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGmail } from "@/__tests__/mocks/fake-gmail-quota";
import { runWithAuditContext } from "@/utils/audit/context";
import { GmailProvider } from "@/utils/email/google";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { resetGmailInflightState } from "@/utils/gmail/inflight";
import { resetGmailQuotaInstanceState } from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { createScopedLogger } from "@/utils/logger";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

// Each quota store call and each Redis call is one Redis command (the store
// sends one script per call), counted by who sent it.
const counted = vi.hoisted(() => ({ commands: new Map<string, number>() }));
const count = (caller: string) =>
  counted.commands.set(caller, (counted.commands.get(caller) ?? 0) + 1);

vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  const store = createMemoryGmailQuotaStore();
  return {
    gmailQuotaStore: new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || property === "reset") return value;
        return (...args: unknown[]) => {
          count(`gmail-quota:${String(property)}`);
          return value.apply(target, args);
        };
      },
    }),
  };
});
// The engine's own envelope admits every page; its scripts answer as Redis
// does when there is room.
vi.mock("@/utils/redis", () => ({
  redis: {
    eval: async (script: string) => {
      const admit = script.includes("ZCARD");
      count(admit ? "local-mail-budget:admit" : "local-mail-budget:release");
      return admit ? 0 : 1;
    },
    get: async (key: string) => {
      count(`get:${key.split(":")[0]}`);
      return null;
    },
    del: async (key: string) => {
      count(`del:${key.split(":")[0]}`);
      return 0;
    },
  },
}));

const ACCOUNT = "account-1";
const PRIMARY_TAKES = [7, 8, 8];
const BACKFILL_TAKES = [8, 7, 8];
const logger = createScopedLogger("enumeration-redis-commands-test");

describe("Redis commands of one enumeration request", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGmailQuotaInstanceState();
    resetGmailInflightState();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A first sync's primary scan is most of the enumeration traffic: each page
  // reads 19 whole messages in batches the per-second pace fits, one after
  // another, so the gate holds most batches until the window or the bucket
  // has room for them.
  it("spends a bounded number of commands on a steady primary scan page", async () => {
    const enumerate = await startScan({ recentCount: 150 });
    let page = await enumerate.begin("primary");
    const pages: { messages: number; commands: Record<string, number> }[] = [];
    for (let n = 0; n < 4 && page; n++) {
      const result = await enumerate(page);
      pages.push(result);
      page = result.nextPage;
    }

    expect(pages.map((p) => p.messages)).toEqual([12, 19, 19, 19]);
    // The list call and five batches of whole messages are six admissions;
    // the rest are batches the window or the bucket held, asked once more
    // after waiting; then the envelope's admission and release. Before each
    // admission said what the next batch would be told, these were 11 takes.
    expect(pages.slice(1).map((p) => p.commands)).toEqual(
      PRIMARY_TAKES.map((takes) => ({
        "gmail-quota:take": takes,
        "local-mail-budget:admit": 1,
        "local-mail-budget:release": 1,
      })),
    );
  });

  it("spends a bounded number of commands on a backfill page", async () => {
    const enumerate = await startScan({ recentCount: 0 });
    let page = await enumerate.begin("history");
    const pages: { messages: number; commands: Record<string, number> }[] = [];
    for (let n = 0; n < 4 && page; n++) {
      const result = await enumerate(page);
      pages.push(result);
      page = result.nextPage;
    }

    expect(pages.map((p) => p.messages)).toEqual([9, 9, 9, 9]);
    // Six admissions again (background batches are two messages); 10 to 11
    // takes before.
    expect(pages.slice(1).map((p) => p.commands)).toEqual(
      BACKFILL_TAKES.map((takes) => ({
        "gmail-quota:take": takes,
        "local-mail-budget:admit": 1,
        "local-mail-budget:release": 1,
      })),
    );
  });
});

async function startScan({ recentCount }: { recentCount: number }) {
  const gmail = createFakeGmail({
    unitsPerMinute: 15_000,
    latencyMs: 100,
    recentCount,
  });
  vi.stubGlobal("fetch", gmail.fetch);
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
  const source = createEmailProviderMailboxSource({
    provider: new GmailProvider(client, logger, ACCOUNT),
    accountId: ACCOUNT,
    logger,
  });
  const context = {
    session: { accountId: ACCOUNT, generation: "gen-a" },
    requestId: "r",
    signal: new AbortController().signal,
  };
  const asRequest = async <T>(route: string, run: () => Promise<T>) => {
    counted.commands.clear();
    const value = await settle(
      runWithAuditContext({ source: route, emailAccountId: ACCOUNT }, run),
    );
    // The provider rate-limit state is read at most once per instance every
    // few seconds, whichever request comes first.
    counted.commands.delete("get:email-provider-rate-limit");
    return { value, commands: Object.fromEntries(counted.commands) };
  };
  return Object.assign(
    async (page: string) => {
      const { value, commands } = await asRequest("mail/v1/enumeration", () =>
        source.enumerate({
          ...context,
          bootstrapId: "mailbox",
          page,
          pageSize: 50,
        }),
      );
      if (value.status !== "ok") throw new Error(`page ${value.status}`);
      return {
        messages: value.value.changes.length,
        nextPage: value.value.nextPage,
        commands,
      };
    },
    {
      async begin(scope: "primary" | "history") {
        const { value } = await asRequest("mail/v1/bootstrap", () =>
          source.beginBootstrap({
            ...context,
            scope: { id: scope, kind: "account", folderId: null },
            afterMs: null,
          }),
        );
        if (value.status !== "ok") throw new Error("bootstrap failed");
        return value.value.enumerationToken;
      },
    },
  );
}

/** Advances the fake clock until `work` settles. */
async function settle<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const done = work.finally(() => {
    settled = true;
  });
  for (let elapsed = 0; !settled && elapsed < 120_000; elapsed += 10)
    await vi.advanceTimersByTimeAsync(10);
  return done;
}
