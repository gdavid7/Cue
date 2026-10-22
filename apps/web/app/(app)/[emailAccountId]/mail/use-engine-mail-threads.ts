"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  ConversationSummary,
  MailboxView,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import type { CombinedListThread } from "@/utils/threads/load-combined";
import type { EmailLabels } from "@/providers/email-label-types";
import {
  type SearchQueryContext,
  searchNeedsProvider,
} from "@/utils/mail-search/search-query-predicate";
import type { ThreadsQuery } from "@/utils/threads/validation";
import { conversationSummaryToListThread } from "@/utils/mail-engine/list-thread";
import { threadsQueryToConversationQuery } from "@/utils/mail-engine/threads-query";
import {
  applyOptimisticTriage,
  useOptimisticTriage,
} from "@/utils/mail-engine/optimistic-triage";
import {
  getFirstSyncAccountIds,
  isMetadataCoverageComplete,
} from "@/utils/mail-engine/coverage";

const EMPTY_THREADS: ListThread[] = [];
const NO_CONVERSATIONS: ConversationSummary[] = [];
const NO_ACCOUNT_IDS: string[] = [];
const NO_LABELS_BY_ACCOUNT: Record<string, EmailLabels> = {};
const NO_PROVIDER_SEARCHES: NonNullable<MailboxView["providerSearch"]> = [];

export function useEngineMailThreads({
  emailAccountId,
  accountIds,
  accounts,
  query,
  predicate,
  search,
  providerSearch = true,
  enabled = true,
}: {
  emailAccountId: string;
  accountIds?: string[];
  accounts?: Record<string, CombinedListThread["account"]>;
  query: ThreadsQuery;
  predicate?: MailPredicate;
  /** How to read a typed search: the account's labels and syntax. */
  search?: Partial<SearchQueryContext>;
  /** False while a search is still being typed: it reads local mail only. */
  providerSearch?: boolean;
  enabled?: boolean;
}) {
  const client = useOptionalMailClient();
  const resolvedAccountIds = useMemo(
    () => accountIds ?? [emailAccountId],
    [accountIds, emailAccountId],
  );
  const conversationQuery = useMemo(() => {
    const baseQuery = threadsQueryToConversationQuery({
      accountIds: resolvedAccountIds,
      query,
      search,
    });
    return {
      ...baseQuery,
      ...(predicate ? { predicate } : {}),
      ...(providerSearch ? {} : { providerSearch: false }),
    };
  }, [resolvedAccountIds, query, predicate, search, providerSearch]);
  const mailbox = useMailboxWindow(conversationQuery, {
    client,
    enabled: enabled && Boolean(client),
  });
  const [failedAccountIds, setFailedAccountIds] = useState<string[]>([]);

  useEffect(() => {
    if (!client || !enabled) return;
    client.requestSync(resolvedAccountIds).catch(() => undefined);
  }, [client, enabled, resolvedAccountIds]);

  useEffect(() => {
    if (!client || !enabled) {
      setFailedAccountIds((current) => (current.length ? [] : current));
      return;
    }
    if (!mailbox.data?.connection || mailbox.data.connection === "ready") {
      setFailedAccountIds((current) => (current.length ? [] : current));
      return;
    }
    let cancelled = false;
    readFailedAccountIds(client, resolvedAccountIds).then((accountIds) => {
      if (!cancelled) setFailedAccountIds(accountIds);
    });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, mailbox.data?.connection, resolvedAccountIds]);

  const coverage = mailbox.data?.coverage;
  // Every pushed snapshot carries fresh coverage; keyed so consumers only see
  // a new list when the set of unsynced accounts actually changes.
  const firstSyncAccountKey =
    client && enabled && coverage
      ? getFirstSyncAccountIds(resolvedAccountIds, coverage).join("\n")
      : "";
  const firstSyncAccountIds = useMemo(
    () =>
      firstSyncAccountKey ? firstSyncAccountKey.split("\n") : NO_ACCOUNT_IDS,
    [firstSyncAccountKey],
  );

  // Archive, read and star show before the engine has written them.
  const optimisticTriage = useOptimisticTriage(client);
  const conversations = useMemo(
    () =>
      applyOptimisticTriage(
        mailbox.data?.conversations ?? NO_CONVERSATIONS,
        conversationQuery.predicate,
        optimisticTriage,
      ),
    [
      mailbox.data?.conversations,
      conversationQuery.predicate,
      optimisticTriage,
    ],
  );

  const previousThreads = useRef<PreviousThreads>({
    rows: new Map(),
    threads: EMPTY_THREADS,
  });
  const threads = useMemo(() => {
    if (!client || !enabled) return EMPTY_THREADS;
    if (!conversations.length) return EMPTY_THREADS;
    return reuseUnchangedThreads(
      previousThreads.current,
      conversations,
      accounts,
    );
  }, [accounts, client, enabled, conversations]);

  // The mail screen shows while the engine starts, and has no answer yet.
  const engineStarting = enabled && !client;
  const lastSyncedAt = lastSyncedAtMs(mailbox.data?.coverage ?? []);
  return {
    threads,
    hasRemoteResponse: !engineStarting && mailbox.status !== "loading",
    searchError: undefined,
    /**
     * Why a typed search may be missing mail: its provider can't be reached,
     * or can't run a search the local mail can't answer at all.
     */
    providerSearchNotice: providerSearchNotice(
      mailbox.data?.providerSearch,
      conversationQuery.predicate,
    ),
    /**
     * A committed search the provider hasn't answered yet, so an empty list
     * isn't its answer.
     */
    providerSearchPending: Boolean(
      mailbox.data?.providerSearch?.some(
        (account) => account.state === "searching" && !account.answered,
      ),
    ),
    /** How far each account's provider got with the view's typed searches. */
    providerSearchAccounts:
      mailbox.data?.providerSearch ?? NO_PROVIDER_SEARCHES,
    isLoading: engineStarting || (enabled && mailbox.status === "loading"),
    error: mailboxQueryError(mailbox.error),
    hasMore: mailbox.canLoadMore,
    isLoadingMore: mailbox.isLoadingMore,
    loadMore: mailbox.loadMore,
    coverageComplete: isMetadataCoverageComplete(mailbox.data?.coverage ?? []),
    /** No sync of this mailbox has finished yet, so an empty list isn't final. */
    isFirstSync:
      enabled &&
      Boolean(client) &&
      !mailbox.data?.coverage.some(
        (coverage) => coverage.lastCompletedSyncAtMs != null,
      ),
    /** A sync of this mailbox has finished, so the engine holds its mail. */
    hasCompletedSync: enabled && Boolean(client) && lastSyncedAt != null,
    /**
     * When the mailbox last finished catching up: its primary stream's last
     * round where there is one, as Gmail's other scopes finish rounds that
     * read no mail.
     */
    lastSyncedAtMs: lastSyncedAt,
    /** Included accounts with no finished sync yet, once the mailbox has loaded. */
    firstSyncAccountIds,
    failedAccountIds,
    labelsByAccount: NO_LABELS_BY_ACCOUNT,
    refetch: async () => {
      await client?.requestSync(resolvedAccountIds);
    },
  };
}

function lastSyncedAtMs(
  coverage: { scopeId: string; lastCompletedSyncAtMs: number | null }[],
) {
  const primary = coverage.find((scope) => scope.scopeId === "primary");
  if (primary) return primary.lastCompletedSyncAtMs;
  const times = coverage.flatMap((scope) =>
    scope.lastCompletedSyncAtMs == null ? [] : [scope.lastCompletedSyncAtMs],
  );
  return times.length ? Math.max(...times) : null;
}

export function useEngineMailClient(): MailClient | null {
  return useOptionalMailClient();
}

type PreviousThreads = {
  rows: Map<
    string,
    {
      summary: string;
      account: CombinedListThread["account"] | undefined;
      thread: ListThread;
    }
  >;
  threads: ListThread[];
};

// Every pushed snapshot is freshly deserialized, so one changed conversation
// would otherwise hand every row a new object and re-render the whole list.
function reuseUnchangedThreads(
  previous: PreviousThreads,
  conversations: ConversationSummary[],
  accounts: Record<string, CombinedListThread["account"]> | undefined,
): ListThread[] {
  const rows: PreviousThreads["rows"] = new Map();
  const threads = conversations.map((conversation) => {
    const key = `${conversation.key.accountId}:${conversation.key.conversationId}`;
    const account = accounts?.[conversation.key.accountId];
    const summary = JSON.stringify(conversation);
    const cached = previous.rows.get(key);
    const thread =
      cached?.summary === summary && cached.account === account
        ? cached.thread
        : conversationSummaryToListThread(conversation, account);
    rows.set(key, { summary, account, thread });
    return thread;
  });
  const unchanged =
    threads.length === previous.threads.length &&
    threads.every((thread, index) => thread === previous.threads[index]);
  previous.rows = rows;
  if (!unchanged) previous.threads = threads;
  return previous.threads;
}

async function readFailedAccountIds(
  client: MailClient,
  accountIds: string[],
): Promise<string[]> {
  const diagnostics = await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        return await client.getDiagnostics(accountId);
      } catch {
        return null;
      }
    }),
  );
  return diagnostics.flatMap((diagnostic, index) => {
    const accountId = accountIds[index];
    return diagnostic?.connection !== "ready" && accountId ? [accountId] : [];
  });
}

export type ProviderSearchNotice = {
  kind: "busy" | "unavailable" | "reconnect" | "unsupported";
  accountId: string;
  /** The provider answered part of the search: a note, not a warning. */
  partial: boolean;
};

// Most severe first.
const NOTICE_ORDER: ProviderSearchNotice["kind"][] = [
  "reconnect",
  "unavailable",
  "busy",
  "unsupported",
];

function providerSearchNotice(
  accounts: MailboxView["providerSearch"],
  predicate: MailPredicate,
): ProviderSearchNotice | null {
  let notice: ProviderSearchNotice | null = null;
  for (const account of accounts ?? []) {
    const kind = account.state;
    if (kind === "searching" || kind === "complete") continue;
    // Outlook not running a search only matters when local mail can't
    // answer any of it.
    if (kind === "unsupported" && !searchNeedsProvider(predicate)) continue;
    if (
      !notice ||
      NOTICE_ORDER.indexOf(kind) < NOTICE_ORDER.indexOf(notice.kind)
    )
      notice = {
        kind,
        accountId: account.accountId,
        partial: account.answered,
      };
  }
  return notice;
}

function mailboxQueryError(
  error: { code: string } | null,
): { error: string; info: { error: string } } | undefined {
  if (!error) return;
  return {
    error: "Couldn't load this mailbox.",
    info: { error: "Couldn't load this mailbox." },
  };
}
