import type { Tool } from "ai";
import { mapWithConcurrency } from "@/utils/async";
import { getConnectedEmailAccounts } from "@/utils/email/connected-accounts";
import type { Logger } from "@/utils/logger";
import { hideToolErrorFromUser } from "@/utils/ai/assistant/tool-error-visibility";
import { parseOtherAccountEmailId } from "@/utils/ai/assistant/other-account-email-id";

// Each other account is searched on a person's behalf while they wait, and
// draws on its own Gmail or Graph budget, so a few run at once and a slow one
// is reported rather than holding up the reply: all of them answer by one
// deadline, however many there are.
const OTHER_ACCOUNTS_CONCURRENCY = 3;
const MAX_OTHER_ACCOUNTS = 10;
const OTHER_ACCOUNTS_DEADLINE_MS = 15_000;

type ConnectedEmailAccount = Awaited<
  ReturnType<typeof getConnectedEmailAccounts>
>[number];

export type OtherAccountResult<T> =
  | { account: ConnectedEmailAccount; result: T }
  | { account: ConnectedEmailAccount; error: string };

/** One of the signed-in user's connected accounts, or null. */
export async function getOwnedEmailAccount({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}) {
  const [account] = await getConnectedEmailAccounts({
    userId,
    accountId: emailAccountId,
  });
  return account ?? null;
}

/**
 * The mailbox an email id from a chat tool is in: the chat's own account for
 * a plain id, or the other account an id names once it is checked to be the
 * user's. Null when it is not, so nothing is read from it.
 */
export async function resolveEmailAccountForId({
  id,
  userId,
  emailAccountId,
  provider,
}: {
  id: string;
  userId: string;
  emailAccountId: string;
  provider: string;
}) {
  const parsed = parseOtherAccountEmailId(id);
  if (!parsed || parsed.emailAccountId === emailAccountId) {
    return {
      emailAccountId,
      provider,
      id: parsed?.id ?? id,
      otherAccount: null,
    };
  }

  const account = await getOwnedEmailAccount({
    userId,
    emailAccountId: parsed.emailAccountId,
  });
  if (!account) return null;
  return {
    emailAccountId: account.id,
    provider: account.provider,
    id: parsed.id,
    otherAccount: account,
  };
}

/**
 * Runs `run` for each of the user's other accounts, a few at once, and
 * answers by one deadline for all of them. At the deadline, or when the chat
 * turn stops, every unfinished search is aborted through the signal it was
 * given, queued accounts are never started, and each is reported as not
 * answering in time.
 */
export async function runOnOtherAccounts<T>({
  userId,
  emailAccountId,
  logger,
  abortSignal,
  run,
}: {
  userId: string;
  /** The chat's own account, which the caller searches itself. */
  emailAccountId: string;
  logger: Logger;
  abortSignal?: AbortSignal;
  run: (account: ConnectedEmailAccount, signal: AbortSignal) => Promise<T>;
}): Promise<OtherAccountResult<T>[]> {
  const accounts = (await getConnectedEmailAccounts({ userId }))
    .filter((account) => account.id !== emailAccountId)
    .slice(0, MAX_OTHER_ACCOUNTS);

  const controller = new AbortController();
  const stop = () => controller.abort();
  if (abortSignal?.aborted) stop();
  abortSignal?.addEventListener("abort", stop, { once: true });
  const deadline = setTimeout(stop, OTHER_ACCOUNTS_DEADLINE_MS);
  const stopped = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    controller.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });

  const finished: Array<OtherAccountResult<T> | undefined> = [];
  try {
    await Promise.race([
      mapWithConcurrency(
        accounts,
        OTHER_ACCOUNTS_CONCURRENCY,
        async (account, index) => {
          if (controller.signal.aborted) return;
          try {
            const result = await run(account, controller.signal);
            if (!controller.signal.aborted)
              finished[index] = { account, result };
          } catch (error) {
            if (controller.signal.aborted) return;
            logger.warn("Search in another account failed", {
              otherEmailAccountId: account.id,
              error,
            });
            finished[index] = {
              account,
              error: "Could not search this account.",
            };
          }
        },
      ),
      stopped,
    ]);
  } finally {
    clearTimeout(deadline);
    abortSignal?.removeEventListener("abort", stop);
  }

  return accounts.map(
    (account, index) =>
      finished[index] ?? {
        account,
        error: "This account did not answer in time.",
      },
  );
}

/**
 * Keeps every tool but the named read tools on the chat's own account: an id
 * from another account's search result is refused before the tool runs, so
 * nothing is changed in either mailbox. The read tools resolve such ids
 * themselves, after checking the account is the user's.
 */
export function withChatAccountScope<T extends Record<string, Tool>>({
  tools,
  userId,
  emailAccountId,
  email,
  crossAccountTools,
}: {
  tools: T;
  userId: string;
  emailAccountId: string;
  /** The chat account's address, for telling the model where it works. */
  email?: string;
  crossAccountTools: Array<keyof T>;
}): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute || crossAccountTools.includes(name)) {
        return [name, definition];
      }
      return [
        name,
        {
          ...definition,
          execute: (
            input: unknown,
            callOptions: Parameters<typeof execute>[1],
          ) => {
            const scoped = scopeInputToChatAccount(input, emailAccountId);
            if (scoped.otherAccountId) {
              return refuseOtherAccountEmail({
                userId,
                otherAccountId: scoped.otherAccountId,
                chatEmail: email,
              });
            }
            return execute(scoped.input, callOptions);
          },
        },
      ];
    }),
  ) as T;
}

function scopeInputToChatAccount(input: unknown, emailAccountId: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { input, otherAccountId: null };
  }

  let otherAccountId: string | null = null;
  const unwrap = (value: string) => {
    const parsed = parseOtherAccountEmailId(value);
    if (!parsed) return value;
    if (parsed.emailAccountId === emailAccountId) return parsed.id;
    otherAccountId ??= parsed.emailAccountId;
    return value;
  };

  const scopedInput = Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (!/Ids?$/.test(key)) return [key, value];
      if (typeof value === "string") return [key, unwrap(value)];
      if (Array.isArray(value)) {
        return [
          key,
          value.map((item) => (typeof item === "string" ? unwrap(item) : item)),
        ];
      }
      return [key, value];
    }),
  );

  return { input: scopedInput, otherAccountId };
}

async function refuseOtherAccountEmail({
  userId,
  otherAccountId,
  chatEmail,
}: {
  userId: string;
  otherAccountId: string;
  chatEmail?: string;
}) {
  const account = await getOwnedEmailAccount({
    userId,
    emailAccountId: otherAccountId,
  });
  if (!account) {
    return hideToolErrorFromUser({
      error:
        "That email is not in any of the user's connected accounts, so nothing was done.",
    });
  }

  const chatAccount = chatEmail ? ` (${chatEmail})` : "";
  return hideToolErrorFromUser({
    error: `This email is in the user's other account ${account.email}. This chat works in its own account${chatAccount} and can only act on that account's email, so nothing was done. Tell the user which account the email is in and that they can switch the chat to ${account.email} to act on it.`,
    emailAccount: account.email,
  });
}
