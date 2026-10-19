import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import {
  getConnectedEngineAccounts,
  markEngineAccountRegistered,
  registerEngineAccounts,
  registerEngineAccountsInTurn,
} from "./engine-accounts";

describe("getConnectedEngineAccounts", () => {
  it("lists every connected account with its provider, including ones left out of All inboxes", () => {
    expect(
      getConnectedEngineAccounts([
        emailAccount({ id: "a", provider: "google" }),
        emailAccount({
          id: "b",
          provider: "microsoft",
          includeInAllAccounts: false,
        }),
        emailAccount({
          id: "c",
          provider: "google",
          disconnectedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    ).toEqual([
      { accountId: "a", provider: "google" },
      { accountId: "b", provider: "microsoft" },
    ]);
  });
});

describe("registerEngineAccounts", () => {
  it("registers accounts the engine doesn't know and syncs them", async () => {
    const client = createClient();
    markEngineAccountRegistered(client, "started");

    await registerEngineAccounts(client, [
      { accountId: "started", provider: "google" },
      { accountId: "unsynced", provider: "microsoft" },
    ]);

    expect(client.ensureAccount).toHaveBeenCalledOnce();
    expect(client.ensureAccount).toHaveBeenCalledWith({
      accountId: "unsynced",
      provider: "microsoft",
    });
    expect(client.requestSync).toHaveBeenCalledWith(["unsynced"]);
  });

  it("tells one engine about an account once, and a new engine again", async () => {
    const client = createClient();
    const accounts = [{ accountId: "a", provider: "google" as const }];

    await registerEngineAccounts(client, accounts);
    await registerEngineAccounts(client, accounts);
    expect(client.ensureAccount).toHaveBeenCalledOnce();

    const replacement = createClient();
    await registerEngineAccounts(replacement, accounts);
    expect(replacement.ensureAccount).toHaveBeenCalledOnce();
  });

  it("tries an account again after it failed to register", async () => {
    const client = createClient();
    client.ensureAccount.mockRejectedValueOnce(new Error("busy"));
    const accounts = [
      { accountId: "a", provider: "google" as const },
      { accountId: "b", provider: "google" as const },
    ];

    await registerEngineAccounts(client, accounts);
    expect(client.requestSync).toHaveBeenCalledWith(["b"]);

    await registerEngineAccounts(client, accounts);
    expect(client.ensureAccount).toHaveBeenCalledTimes(3);
    expect(client.requestSync).toHaveBeenLastCalledWith(["a"]);
  });
});

describe("registerEngineAccountsInTurn", () => {
  const accounts = ["a", "b", "c"].map((accountId) => ({
    accountId,
    provider: "google" as const,
  }));

  it("never runs two background accounts' first syncs at once", async () => {
    const engine = createSyncingEngine();

    const done = registerEngineAccountsInTurn(
      engine.client,
      accounts,
      new AbortController().signal,
    );
    for (const accountId of ["a", "b", "c"]) {
      await vi.waitFor(() => expect(engine.syncing).toEqual([accountId]));
      engine.finishFirstSync(accountId);
    }
    await done;

    expect(engine.mostAtOnce).toBe(1);
    expect(engine.started).toEqual(["a", "b", "c"]);
  });

  it("moves on from an account whose first sync runs too long", async () => {
    vi.useFakeTimers();
    const engine = createSyncingEngine();

    const done = registerEngineAccountsInTurn(
      engine.client,
      accounts.slice(0, 2),
      new AbortController().signal,
      { firstSyncWaitMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.started).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.started).toEqual(["a", "b"]);
    engine.finishFirstSync("b");
    await done;
    vi.useRealTimers();
  });

  it("stops registering once the engine goes", async () => {
    const engine = createSyncingEngine();
    const abort = new AbortController();

    const done = registerEngineAccountsInTurn(
      engine.client,
      accounts,
      abort.signal,
    );
    await vi.waitFor(() => expect(engine.started).toEqual(["a"]));
    abort.abort();
    await done;

    expect(engine.started).toEqual(["a"]);
  });
});

// An engine whose registered accounts sync on their own, as the real one's
// lanes do, until the test finishes each account's first sync.
function createSyncingEngine() {
  const syncing: string[] = [];
  const started: string[] = [];
  const synced = new Set<string>();
  const listeners = new Set<() => void>();
  let mostAtOnce = 0;
  const client = {
    ensureAccount: vi.fn(async () => undefined),
    requestSync: vi.fn(async (accountIds: string[]) => {
      for (const accountId of accountIds) {
        if (synced.has(accountId) || syncing.includes(accountId)) continue;
        syncing.push(accountId);
        started.push(accountId);
        mostAtOnce = Math.max(mostAtOnce, syncing.length);
      }
      return { status: "scheduled" };
    }),
    observeMailbox: vi.fn(({ accountIds }: { accountIds: string[] }) => ({
      getSnapshot: () => ({
        status: "ready",
        data: {
          coverage: accountIds.map((accountId) => ({
            accountId,
            lastCompletedSyncAtMs: synced.has(accountId) ? 1 : null,
          })),
        },
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => undefined,
    })),
  } as unknown as MailClient;
  return {
    client,
    syncing,
    started,
    get mostAtOnce() {
      return mostAtOnce;
    },
    finishFirstSync(accountId: string) {
      syncing.splice(syncing.indexOf(accountId), 1);
      synced.add(accountId);
      for (const listener of [...listeners]) listener();
    },
  };
}

function createClient() {
  return {
    ensureAccount: vi.fn().mockResolvedValue(undefined),
    requestSync: vi.fn().mockResolvedValue({ status: "scheduled" }),
  } as unknown as MailClient & {
    ensureAccount: ReturnType<typeof vi.fn>;
    requestSync: ReturnType<typeof vi.fn>;
  };
}

function emailAccount(input: {
  id: string;
  provider: string;
  includeInAllAccounts?: boolean;
  disconnectedAt?: string | null;
}) {
  return {
    id: input.id,
    includeInAllAccounts: input.includeInAllAccounts ?? true,
    account: {
      provider: input.provider,
      disconnectedAt: input.disconnectedAt ?? null,
    },
  } as unknown as GetEmailAccountsResponse["emailAccounts"][number];
}
