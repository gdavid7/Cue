import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import {
  getConnectedEngineAccounts,
  markEngineAccountRegistered,
  registerEngineAccounts,
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
