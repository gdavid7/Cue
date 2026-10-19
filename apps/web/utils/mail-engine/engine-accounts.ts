import type { MailClient } from "@inboxzero/mail-core/engine";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { isMicrosoftProvider } from "@/utils/email/provider-types";

type EngineAccount = {
  accountId: string;
  provider: "google" | "microsoft";
};

// Matches how many accounts the new-mail notifier watches.
const MAX_REGISTERED_ACCOUNTS = 50;

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
      provider: isMicrosoftProvider(emailAccount.account.provider)
        ? "microsoft"
        : "google",
    }));
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

/** Records an account the engine already knows, such as the one it started on. */
export function markEngineAccountRegistered(
  client: MailClient,
  accountId: string,
) {
  const registered = registeredByClient.get(client) ?? new Set<string>();
  registered.add(accountId);
  registeredByClient.set(client, registered);
}
