import type { MailClient } from "@inboxzero/mail-core/engine";
import type { Provider } from "@inboxzero/mail-core/identities";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { isMicrosoftProvider } from "@/utils/email/provider-types";

type EngineAccount = {
  accountId: string;
  provider: Provider;
};

// Matches how many accounts the new-mail notifier watches.
const MAX_REGISTERED_ACCOUNTS = 50;

// A background account whose first sync takes longer than this stops holding
// back the next one, so one huge or stuck mailbox can't keep the rest unsynced.
const FIRST_SYNC_WAIT_MS = 2 * 60_000;

const registeredByClient = new WeakMap<MailClient, Set<string>>();

/** Every connected account, as the engine registers it. */
export function getConnectedEngineAccounts(
  emailAccounts: GetEmailAccountsResponse["emailAccounts"],
): EngineAccount[] {
  return emailAccounts
    .filter((emailAccount) => !emailAccount.account.disconnectedAt)
    .slice(0, MAX_REGISTERED_ACCOUNTS)
    .map((emailAccount) => ({
      accountId: emailAccount.id,
      provider: engineProvider(emailAccount.account.provider),
    }));
}

/** An account's provider as the mail engine names it. */
export function engineProvider(provider: string): Provider {
  return isMicrosoftProvider(provider) ? "microsoft" : "google";
}

/**
 * The local engine syncs only the accounts it has been told about, and a
 * started engine knows only the account it started on. Telling it about every
 * connected account lets an account the user hasn't opened in this browser
 * sync, and so notify. Each engine is told about an account once.
 */
export async function registerEngineAccounts(
  client: MailClient,
  accounts: EngineAccount[],
) {
  const ensureAccount = client.ensureAccount?.bind(client);
  if (!ensureAccount) return;
  let registered = registeredByClient.get(client);
  if (!registered) {
    registered = new Set();
    registeredByClient.set(client, registered);
  }
  const known = registered;
  const added = accounts.filter((account) => !known.has(account.accountId));
  if (added.length === 0) return;
  for (const account of added) known.add(account.accountId);
  const results = await Promise.allSettled(
    added.map((account) => ensureAccount(account)),
  );
  const ensured = added.filter((account, index) => {
    if (results[index]?.status === "fulfilled") return true;
    // Told again on the next change, rather than never.
    known.delete(account.accountId);
    return false;
  });
  if (ensured.length === 0) return;
  await client.requestSync(ensured.map((account) => account.accountId));
}

/**
 * {@link registerEngineAccounts} one account at a time, for accounts nobody is
 * looking at. Registering only queues an account's sync, so each waits until
 * the one before has finished its first sync (or can't, or has run past
 * `firstSyncWaitMs`): their first syncs never run side by side, crowding the
 * worker, the store and the network. Stops once `signal` aborts.
 */
export async function registerEngineAccountsInTurn(
  client: MailClient,
  accounts: EngineAccount[],
  signal: AbortSignal,
  { firstSyncWaitMs = FIRST_SYNC_WAIT_MS }: { firstSyncWaitMs?: number } = {},
) {
  for (const account of accounts) {
    if (signal.aborted) return;
    await registerEngineAccounts(client, [account]).catch(() => undefined);
    await waitForFirstSync(client, account.accountId, signal, firstSyncWaitMs);
  }
}

/** Records an account the engine already knows, such as the one it started on. */
export function markEngineAccountRegistered(
  client: MailClient,
  accountId: string,
) {
  const registered = registeredByClient.get(client) ?? new Set<string>();
  registered.add(accountId);
  registeredByClient.set(client, registered);
}

function waitForFirstSync(
  client: MailClient,
  accountId: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return new Promise<void>((resolve) => {
    const handle = client.observeMailbox({
      accountIds: [accountId],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 1,
      after: null,
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      unsubscribe();
      handle.close();
      resolve();
    };
    const inspect = () => {
      const view = handle.getSnapshot().data;
      if (!view) return;
      // An account that can't sign in or reach its provider won't finish.
      if (view.connection === "blocked_auth" || view.connection === "offline")
        finish();
      else if (
        view.coverage.some(
          (entry) =>
            entry.accountId === accountId &&
            entry.lastCompletedSyncAtMs !== null,
        )
      )
        finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener("abort", finish, { once: true });
    let unsubscribe = () => {};
    unsubscribe = handle.subscribe(inspect);
    inspect();
  });
}
