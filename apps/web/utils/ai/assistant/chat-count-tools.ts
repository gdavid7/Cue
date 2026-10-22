import { type InferUITool, tool } from "ai";
import { z } from "zod";
import {
  COUNT_GROUP_BY,
  type CountGroupBy,
  LOCAL_COUNT_LIMITS,
  type LocalCountSearch,
} from "@/utils/actions/assistant-local-search.validation";
import type {
  MatchingFilter,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import { mapWithConcurrency } from "@/utils/async";
import {
  type AccountSearch,
  translateAccountSearch,
} from "@/utils/ai/assistant/cross-provider-search";
import type {
  LocalMailCountAnswer,
  LocalMailSearch,
} from "@/utils/ai/assistant/local-mail-search";
import { toOtherAccountEmailId } from "@/utils/ai/assistant/other-account-email-id";
import { getConnectedEmailAccounts } from "@/utils/email/connected-accounts";
import { createEmailProvider } from "@/utils/email/provider";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { describeProviderRateLimitError } from "@/utils/email/rate-limit";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  getOutlookLocalSearch,
  normalizeOutlookSearchInput,
} from "@/utils/outlook/assistant-search";

// Without a local count, the provider lists matching ids, 500 a page (one
// Gmail messages.list, 5 quota units). Past this the total is a lower bound.
export const PROVIDER_COUNT_MAX_MESSAGES = 5000;
const MAX_OTHER_ACCOUNTS = 10;
const ACCOUNT_CONCURRENCY = 3;

type CountAccount = { id: string; email: string; provider: string };

type CountEmailsOptions = {
  email: string;
  emailAccountId: string;
  provider: string;
  userId: string;
  logger: Logger;
  localMailSearch?: LocalMailSearch;
};

const groupByField = z
  .enum(COUNT_GROUP_BY)
  .nullish()
  .describe(
    "Optional. Groups the matches by sender, month, week or label. Mail the user sent is left out of sender groups, and a message counts once for each of its labels.",
  );

const allAccountsField = z
  .boolean()
  .nullish()
  .describe(
    "Optional. Set to true to also count the user's other connected email accounts. Each account's total is then listed too.",
  );

const gmailCountEmailsInputSchema = z.object({
  query: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe(
      "Gmail search for the emails to count, in searchInbox's syntax. Leave empty to count all mail.",
    ),
  groupBy: groupByField,
  allAccounts: allAccountsField,
});

const outlookCountEmailsInputSchema = z.object({
  query: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe(
      "Outlook search for the emails to count, in searchInbox's query syntax; write an exact sender as from:person@example.com. Leave empty to count all mail.",
    ),
  groupBy: groupByField,
  allAccounts: allAccountsField,
});

type CountEmailsInput = z.infer<typeof gmailCountEmailsInputSchema>;

const COUNT_EMAILS_DESCRIPTION =
  "Count every email that matches a search across the whole mailbox, optionally grouped. Use it instead of paging searchInbox when the user asks how many emails there are, who sends the most, or how mail spreads over time or labels. Returns the exact total, the largest groups (senders or labels, most first) or the latest periods (months or weeks, newest first), and the newest few matches. If exact is false, say the number is partial or a lower bound and why. It does not change any email.";

export const countEmailsTool = (options: CountEmailsOptions) =>
  tool({
    description: COUNT_EMAILS_DESCRIPTION,
    inputSchema: isMicrosoftProvider(options.provider)
      ? outlookCountEmailsInputSchema
      : gmailCountEmailsInputSchema,
    execute: (input, callOptions) =>
      countEmails({ options, input, abortSignal: callOptions?.abortSignal }),
  });

export type CountEmailsTool = InferUITool<ReturnType<typeof countEmailsTool>>;

/**
 * Counts every match of a chat search in the chat's account and, when asked,
 * the user's other included accounts. Counts come from the browser's local
 * mail store where it can count an account exactly, and otherwise from the
 * provider's own listing of matching ids, bounded. Only totals, the top
 * groups and a few examples' headers come back; the matches themselves never
 * reach the model.
 */
export async function countEmails({
  options,
  input,
  abortSignal,
}: {
  options: CountEmailsOptions;
  input: CountEmailsInput;
  abortSignal?: AbortSignal;
}) {
  const { emailAccountId, email, provider, userId, logger, localMailSearch } =
    options;
  const groupBy = input.groupBy ?? undefined;
  const chatAccount: CountAccount = { id: emailAccountId, email, provider };
  const chatSearch: AccountSearch = { query: input.query };

  const accounts = [
    { account: chatAccount, search: chatSearch, keywordsOnly: false },
  ];
  const notSearched: Array<{ account: string; error: string }> = [];
  if (input.allAccounts) {
    for (const account of await getIncludedOtherAccounts({
      userId,
      emailAccountId,
    })) {
      const translated = translateAccountSearch({
        search: chatSearch,
        from: provider,
        to: account.provider,
      });
      if (!translated) {
        notSearched.push({
          account: account.email,
          error: "Nothing in this search applies to this account.",
        });
        continue;
      }
      accounts.push({ account, ...translated });
    }
  }

  const local = localMailSearch?.count
    ? await localMailSearch.count({
        searches: accounts.flatMap(({ account, search }) => {
          const localSearch = toLocalCountSearch(account, search);
          return localSearch ? [localSearch] : [];
        }),
        groupBy,
      })
    : null;

  const perAccount = await mapWithConcurrency(
    accounts,
    ACCOUNT_CONCURRENCY,
    async ({ account, search, keywordsOnly }) => {
      const counted = local?.accounts.find(
        (item) => item.accountId === account.id && item.total !== undefined,
      );
      if (counted?.total !== undefined) {
        return {
          account,
          keywordsOnly,
          total: counted.total,
          exact: true,
          grouped: true,
          newestIds: [] as Array<{ id: string; threadId: string }>,
        };
      }
      abortSignal?.throwIfAborted();
      try {
        const emailProvider = await createEmailProvider({
          emailAccountId: account.id,
          provider: account.provider,
          logger,
        });
        const listed = await countWithProvider({
          emailProvider,
          ...toMatchingScope(search),
          abortSignal,
        });
        return {
          account,
          keywordsOnly,
          total: listed.total,
          exact: !listed.capped,
          grouped: false,
          newestIds: listed.newestIds,
        };
      } catch (error) {
        logger.warn("Could not count an account's matching mail", {
          countEmailAccountId: account.id,
          error,
        });
        return {
          account,
          keywordsOnly,
          error:
            describeProviderRateLimitError(error, account.provider) ??
            "Could not count this account's mail.",
        };
      }
    },
  );

  const counted = perAccount.filter(
    (item): item is Extract<typeof item, { total: number }> => "total" in item,
  );
  if (!counted.length) {
    return {
      queryUsed: input.query,
      error:
        perAccount.find((item) => "error" in item && item.error)?.error ??
        "Could not count matching emails.",
    };
  }

  const accountsById = new Map(
    accounts.map(({ account }) => [account.id, account]),
  );
  const providers = new Map<string, Promise<EmailProvider>>();
  const providerFor = (account: CountAccount) => {
    let emailProvider = providers.get(account.id);
    if (!emailProvider) {
      emailProvider = createEmailProvider({
        emailAccountId: account.id,
        provider: account.provider,
        logger,
      });
      providers.set(account.id, emailProvider);
    }
    return emailProvider;
  };

  const exampleRefs = [
    ...(local?.newest ?? []).filter((item) =>
      counted.some(
        (entry) => entry.grouped && entry.account.id === item.accountId,
      ),
    ),
    ...counted.flatMap((entry) =>
      entry.newestIds.map((item) => ({ ...item, accountId: entry.account.id })),
    ),
  ];
  const groupRefs = groupBy
    ? (local?.groups ?? []).filter((group) => accountsById.has(group.accountId))
    : [];
  const headers = await readHeaders({
    refs: [
      ...exampleRefs,
      ...(groupBy === "sender"
        ? groupRefs.map((group) => ({
            id: group.messageId,
            accountId: group.accountId,
          }))
        : []),
    ],
    accountsById,
    providerFor,
    logger,
  });

  const newest = exampleRefs
    .flatMap((ref) => {
      const header = headers.get(headerKey(ref.accountId, ref.id));
      const account = accountsById.get(ref.accountId);
      if (!header || !account) return [];
      const otherAccount = account.id !== emailAccountId;
      return [
        {
          messageId: otherAccount
            ? toOtherAccountEmailId(account.id, header.id)
            : header.id,
          threadId: otherAccount
            ? toOtherAccountEmailId(account.id, header.threadId)
            : header.threadId,
          subject: header.subject,
          from: header.from,
          date: header.date,
          ...(input.allAccounts ? { account: account.email } : {}),
        },
      ];
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, LOCAL_COUNT_LIMITS.newest);

  const groups = groupBy
    ? await describeGroups({
        groupBy,
        local,
        headers,
        accountsById,
        providerFor,
        logger,
      })
    : null;
  const ungrouped = counted.filter((entry) => !entry.grouped);
  const failed = perAccount.filter(
    (item): item is Extract<typeof item, { error: string }> => "error" in item,
  );

  return {
    queryUsed: input.query,
    total: counted.reduce((sum, entry) => sum + entry.total, 0),
    exact:
      counted.every((entry) => entry.exact) &&
      failed.length === 0 &&
      notSearched.length === 0,
    ...(groupBy && groups
      ? {
          groupBy,
          groups: groups.items,
          ...(groups.more > 0 ? { moreGroups: groups.more } : {}),
          ...(ungrouped.length
            ? {
                groupsIncomplete:
                  "Some matching mail could only be counted, not grouped, because this device has not finished syncing it.",
              }
            : {}),
        }
      : {}),
    newest,
    ...(input.allAccounts
      ? {
          accounts: [
            ...perAccount.map((item) =>
              "error" in item
                ? { account: item.account.email, error: item.error }
                : {
                    account: item.account.email,
                    total: item.total,
                    exact: item.exact,
                    ...(item.keywordsOnly ? { keywordsOnly: true } : {}),
                  },
            ),
            ...notSearched,
          ],
        }
      : {}),
  };
}

/**
 * The bulk-action scope for a chat search: the same view the inbox's
 * select-all would list. A search covers the whole mailbox; an empty one is
 * all mail. Outlook's sender and read state become search-box terms and a
 * read filter.
 */
export function toMatchingScope(search: AccountSearch): {
  scope: MatchingScope;
  only: MatchingFilter;
} {
  const q = [
    search.query.trim(),
    search.fromEmail ? `from:${search.fromEmail}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    scope: q ? { q } : { type: "all" },
    only: search.readState ? { unread: search.readState === "unread" } : {},
  };
}

/**
 * Lists matching ids page by page until the end or the cap. Resolves the
 * count and the first few ids, which are the newest the provider listed.
 */
export async function countWithProvider({
  emailProvider,
  scope,
  only,
  maxMessages = PROVIDER_COUNT_MAX_MESSAGES,
  abortSignal,
}: {
  emailProvider: EmailProvider;
  scope: MatchingScope;
  only: MatchingFilter;
  maxMessages?: number;
  abortSignal?: AbortSignal;
}) {
  const threads = new Set<string>();
  const newestIds: Array<{ id: string; threadId: string }> = [];
  let total = 0;
  let pageToken: string | undefined;
  do {
    abortSignal?.throwIfAborted();
    const page = await emailProvider.listMatchingMessages({
      scope,
      only,
      pageToken,
    });
    for (const message of page.messages) {
      total += 1;
      threads.add(message.threadId);
      if (newestIds.length < LOCAL_COUNT_LIMITS.newest) newestIds.push(message);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && total < maxMessages);
  return {
    total,
    conversations: threads.size,
    capped: Boolean(pageToken),
    newestIds,
  };
}

async function getIncludedOtherAccounts({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<CountAccount[]> {
  const accounts = await getConnectedEmailAccounts({
    userId,
    includeInAllAccounts: true,
  });
  return accounts
    .filter((account) => account.id !== emailAccountId)
    .slice(0, MAX_OTHER_ACCOUNTS)
    .map((account) => ({
      id: account.id,
      email: account.email,
      provider: account.provider,
    }));
}

function toLocalCountSearch(
  account: CountAccount,
  search: AccountSearch,
): LocalCountSearch | null {
  if (!isMicrosoftProvider(account.provider))
    return { accountId: account.id, query: search.query, syntax: "gmail" };
  // Read the way searchInbox reads it, so a count matches what a search lists.
  let normalized: ReturnType<typeof normalizeOutlookSearchInput>;
  try {
    normalized = normalizeOutlookSearchInput({
      query: search.query,
      fromEmail: search.fromEmail,
      readState: search.readState,
    });
  } catch {
    return null;
  }
  const local = getOutlookLocalSearch(normalized);
  return local ? { accountId: account.id, ...local.request } : null;
}

type Header = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
};

/** The few messages' headers, read from each one's own account. */
async function readHeaders({
  refs,
  accountsById,
  providerFor,
  logger,
}: {
  refs: Array<{ id: string; accountId: string }>;
  accountsById: Map<string, CountAccount>;
  providerFor: (account: CountAccount) => Promise<EmailProvider>;
  logger: Logger;
}) {
  const headers = new Map<string, Header>();
  const idsByAccount = new Map<string, Set<string>>();
  for (const ref of refs) {
    const ids = idsByAccount.get(ref.accountId) ?? new Set<string>();
    ids.add(ref.id);
    idsByAccount.set(ref.accountId, ids);
  }
  await Promise.all(
    [...idsByAccount].map(async ([accountId, ids]) => {
      const account = accountsById.get(accountId);
      if (!account) return;
      try {
        const emailProvider = await providerFor(account);
        for (const message of await emailProvider.getMessagesBatch([...ids])) {
          headers.set(headerKey(accountId, message.id), {
            id: message.id,
            threadId: message.threadId,
            subject: message.subject || message.headers.subject,
            from: message.headers.from,
            date: message.date,
          });
        }
      } catch (error) {
        logger.warn("Could not read counted emails' headers", {
          countEmailAccountId: accountId,
          error,
        });
      }
    }),
  );
  return headers;
}

async function describeGroups({
  groupBy,
  local,
  headers,
  accountsById,
  providerFor,
  logger,
}: {
  groupBy: CountGroupBy;
  local: LocalMailCountAnswer | null;
  headers: Map<string, Header>;
  accountsById: Map<string, CountAccount>;
  providerFor: (account: CountAccount) => Promise<EmailProvider>;
  logger: Logger;
}) {
  const groups = (local?.groups ?? []).filter((group) =>
    accountsById.has(group.accountId),
  );
  const labelNames =
    groupBy === "label"
      ? await readLabelNames({
          accountIds: [...new Set(groups.map((group) => group.accountId))],
          accountsById,
          providerFor,
          logger,
        })
      : null;

  type GroupItem = { count: number } & (
    | { sender: string }
    | { label: string }
    | { month: string }
    | { weekOf: string }
  );
  const items = groups.flatMap((group): GroupItem[] => {
    switch (groupBy) {
      case "sender": {
        const from = headers.get(
          headerKey(group.accountId, group.messageId),
        )?.from;
        return from ? [{ sender: from, count: group.count }] : [];
      }
      case "label": {
        const name =
          group.key && labelNames?.get(headerKey(group.accountId, group.key));
        return name ? [{ label: name, count: group.count }] : [];
      }
      case "month":
        return group.key ? [{ month: group.key, count: group.count }] : [];
      case "week":
        return group.key ? [{ weekOf: group.key, count: group.count }] : [];
    }
  });
  return {
    items,
    more: Math.max(0, (local?.groupCount ?? 0) - items.length),
  };
}

async function readLabelNames({
  accountIds,
  accountsById,
  providerFor,
  logger,
}: {
  accountIds: string[];
  accountsById: Map<string, CountAccount>;
  providerFor: (account: CountAccount) => Promise<EmailProvider>;
  logger: Logger;
}) {
  const names = new Map<string, string>();
  await Promise.all(
    accountIds.map(async (accountId) => {
      const account = accountsById.get(accountId);
      if (!account) return;
      try {
        const labels = await (await providerFor(account)).getLabels();
        for (const label of labels)
          names.set(headerKey(accountId, label.id), label.name);
      } catch (error) {
        logger.warn("Could not read label names for a count", {
          countEmailAccountId: accountId,
          error,
        });
      }
    }),
  );
  return names;
}

function headerKey(accountId: string, id: string) {
  return `${accountId}\u0000${id}`;
}
