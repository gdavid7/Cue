import type { Logger } from "@/utils/logger";
import type { EmailLabel, EmailLabels } from "@/providers/email-label-types";
import type { ThreadListItem } from "@/utils/threads/load";
import {
  mergePaginatedSources,
  type PageBuffer,
} from "@/utils/threads/merge-paginated-sources";
import { getThreadTimestamp } from "@/utils/threads/sort";
import { showCopiesOnce } from "@/utils/threads/cross-account-copies";
import { GmailLabel } from "@/utils/gmail/label";

const ACCOUNT_CONCURRENCY = 4;

export type CombinedThreadsAccount = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  provider: string;
};

type CombinedAccount = Pick<
  CombinedThreadsAccount,
  "id" | "email" | "name" | "image"
>;

export type CombinedListThread = ThreadListItem & {
  account: CombinedAccount;
  /** The user's other accounts this row's newest message was delivered to. */
  alsoIn?: CombinedAccount[];
};

export async function loadCombinedThreads({
  accounts,
  cursor,
  limit,
  loadPage,
  logger,
  pageBuffer,
}: {
  accounts: CombinedThreadsAccount[];
  cursor: string | null;
  limit: number;
  loadPage: (input: {
    account: CombinedThreadsAccount;
    pageToken?: string;
  }) => Promise<{
    threads: ThreadListItem[];
    nextPageToken?: string | null;
    labels?: EmailLabel[];
  }>;
  logger: Logger;
  pageBuffer?: PageBuffer<CombinedListThread, EmailLabel[]>;
}) {
  const { items, metaBySourceId, failedSourceIds, nextPageToken } =
    await mergePaginatedSources({
      sources: accounts,
      pageBuffer,
      cursor,
      limit,
      concurrency: ACCOUNT_CONCURRENCY,
      compare: (left, right) =>
        getThreadTimestamp(right) - getThreadTimestamp(left),
      getItemId: (thread: CombinedListThread) => thread.id,
      loadPage: async ({ source: account, pageToken }) => {
        const page = await loadPage({ account, pageToken });
        return {
          items: page.threads.map((thread) => ({
            ...thread,
            account: {
              id: account.id,
              email: account.email,
              name: account.name,
              image: account.image,
            },
          })),
          nextPageToken: page.nextPageToken,
          meta: page.labels,
        };
      },
      onSourceError: ({ source: account, error }) =>
        logger.warn("Failed to load combined mailbox account", {
          error,
          emailAccountId: account.id,
        }),
    });

  const labelsByAccount: Record<string, EmailLabels> = {};
  for (const [accountId, labels] of Object.entries(metaBySourceId)) {
    labelsByAccount[accountId] = Object.fromEntries(
      labels.map((label) => [label.id, label]),
    );
  }

  // Within the page only: a copy past it shows on a later page as its own
  // row, as remembering it would put its Message-ID in the cursor.
  const accountsById = new Map(
    items.map((item) => [item.account.id, item.account]),
  );
  const threads = showCopiesOnce(items, (thread) => ({
    accountId: thread.account.id,
    messageId: thread.messages.findLast(
      (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
    )?.headers["message-id"],
  })).map(({ row, alsoIn }) =>
    alsoIn.length
      ? {
          ...row,
          alsoIn: alsoIn.flatMap((id) => accountsById.get(id) ?? []),
        }
      : row,
  );

  return {
    threads,
    labelsByAccount,
    nextPageToken,
    failedAccountIds: failedSourceIds,
  };
}
