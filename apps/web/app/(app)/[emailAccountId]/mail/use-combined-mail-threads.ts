"use client";

import { useEffect, useMemo } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import {
  MAX_MESSAGE_PREDICATE_IDS,
  type MailPredicate,
} from "@inboxzero/mail-core/queries";
import useSWR from "swr";
import { useSWRConfig } from "swr";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  useEngineMailClient,
  useEngineMailThreads,
} from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import type { LabelsResponse } from "@/app/api/labels/route";
import type { EmailLabels } from "@/providers/email-label-types";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { registerEngineAccounts } from "@/utils/mail-engine/engine-accounts";
import { searchQueryForAccounts } from "@/utils/mail-search/search-query-predicate";
import type { ThreadsQuery } from "@/utils/threads/validation";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import {
  type HiddenDrafts,
  useAllAccountsHiddenDraftMessageIds,
} from "@/hooks/useHiddenDraftMessageIds";

const EMPTY_LABELS_BY_ACCOUNT: Record<string, EmailLabels> = {};
const MAX_MAIL_PREDICATE_CHILDREN = 32;

export function useCombinedMailThreads({
  accounts,
  emailAccountId,
  enabled,
  isUnread,
  mailboxType,
  labelNames,
  searchQuery,
  providerSearch,
}: {
  accounts: AllInboxesAccount[];
  emailAccountId: string;
  enabled: boolean;
  isUnread: boolean;
  /** Drafts, Sent or Starred, merged in place of the inbox. */
  mailboxType?: string;
  labelNames?: string[];
  searchQuery?: string;
  /** False while a search is still being typed: it reads local mail only. */
  providerSearch?: boolean;
}) {
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  const accountsById = useMemo(
    () => Object.fromEntries(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const labelsByAccount = useLabelsByAccount(enabled ? accountIds : []);
  const isDrafts = !searchQuery && mailboxType === "draft";
  const hiddenDrafts = useAllAccountsHiddenDraftMessageIds(
    enabled && isDrafts ? accounts : undefined,
  );
  const predicate = useMemo(() => {
    // A conversation stays in Drafts only through drafts that aren't hidden.
    if (isDrafts)
      return hiddenDrafts.length
        ? withoutAccountsHiddenDrafts(hiddenDrafts)
        : undefined;
    if (mailboxType) return;
    return labelNames?.length
      ? labelNamesToAccountScopedPredicate({
          accountIds,
          labelsByAccount,
          labelNames,
        })
      : undefined;
  }, [
    accountIds,
    hiddenDrafts,
    isDrafts,
    labelNames,
    labelsByAccount,
    mailboxType,
  ]);
  // Each account reads the search in its own provider's syntax, and
  // `label:Name` by its own labels.
  const searchPredicate = useMemo(
    () =>
      searchQuery
        ? (searchQueryForAccounts(
            searchQuery,
            { now: new Date() },
            accounts.map((account) => {
              const labels = labelsByAccount[account.id];
              return {
                id: account.id,
                provider: account.provider,
                labels: labels && Object.values(labels),
              };
            }),
          ) ?? undefined)
        : undefined,
    [searchQuery, accounts, labelsByAccount],
  );
  const query = useMemo<ThreadsQuery>(() => {
    if (searchQuery) return { q: searchQuery };
    if (mailboxType) return { type: mailboxType };
    if (labelNames?.length) {
      return { type: "inbox" };
    }
    if (isUnread) return { type: "unread" };
    return { type: "inbox" };
  }, [isUnread, labelNames, mailboxType, searchQuery]);
  const state = useEngineMailThreads({
    emailAccountId,
    accountIds: accountIds.length ? accountIds : [emailAccountId],
    accounts: accountsById,
    query,
    predicate: searchQuery ? searchPredicate : predicate,
    providerSearch,
    enabled,
  });
  const client = useEngineMailClient();
  const { firstSyncAccountIds, failedAccountIds } = state;

  // The local engine only syncs accounts it has been told about, and only the
  // routed account is registered on startup. Without this, an account never
  // opened alone in this browser contributes nothing to All inboxes.
  useEffect(() => {
    if (!client || !enabled) return;
    const unsynced = firstSyncAccountIds.flatMap((accountId) => {
      const account = accountsById[accountId];
      return account ? [account] : [];
    });
    if (unsynced.length) startFirstSync(client, unsynced);
  }, [accountsById, client, enabled, firstSyncAccountIds]);

  const firstSyncAccounts = useMemo(
    () =>
      firstSyncAccountIds.flatMap((accountId) => {
        const account = accountsById[accountId];
        return account && !failedAccountIds.includes(accountId)
          ? [account]
          : [];
      }),
    [accountsById, failedAccountIds, firstSyncAccountIds],
  );

  return {
    ...state,
    /** Included accounts whose first sync in this browser is still running. */
    firstSyncAccounts,
    labelsByAccount,
  };
}

function startFirstSync(client: MailClient, accounts: AllInboxesAccount[]) {
  registerEngineAccounts(
    client,
    accounts.map((account) => ({
      accountId: account.id,
      provider: isMicrosoftProvider(account.provider) ? "microsoft" : "google",
    })),
  )
    .then(() => client.requestSync(accounts.map((account) => account.id)))
    .catch(() => undefined);
}

function useLabelsByAccount(accountIds: string[]): Record<string, EmailLabels> {
  const { fetcher } = useSWRConfig();
  const accountKey = useMemo(
    () => [...accountIds].sort().join(":"),
    [accountIds],
  );
  const { data } = useSWR(
    fetcher && accountIds.length
      ? ["mail-labels-by-account", accountKey]
      : null,
    async () => {
      if (!fetcher) return {};
      const entries = await Promise.all(
        accountIds.map(async (accountId) => {
          // One account's failed fetch leaves only that account without
          // labels, rather than every account.
          let response: LabelsResponse | undefined;
          try {
            response = (await fetcher(["/api/labels", accountId])) as
              | LabelsResponse
              | undefined;
          } catch {
            response = undefined;
          }
          return [accountId, labelsResponseToMap(response)] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
    { revalidateOnFocus: false },
  );
  return data ?? EMPTY_LABELS_BY_ACCOUNT;
}

function labelsResponseToMap(
  response: LabelsResponse | undefined,
): EmailLabels {
  if (!response?.labels) return {};
  return Object.fromEntries(
    response.labels
      .filter((label) => label.type === "user")
      .map((label) => [
        label.id || "",
        {
          id: label.id || "",
          name: label.name || "",
          type: label.type || null,
          color: label.color,
          labelListVisibility: label.labelListVisibility,
          messageListVisibility: label.messageListVisibility,
        },
      ]),
  );
}

export function labelNamesToAccountScopedPredicate({
  accountIds,
  labelsByAccount,
  labelNames,
}: {
  accountIds: string[];
  labelsByAccount: Record<string, EmailLabels>;
  labelNames: string[];
}): MailPredicate {
  const wantedNames = new Set(labelNames.map((name) => name.trim()));
  const predicates: MailPredicate[] = [];
  const seen = new Set<string>();

  for (const accountId of accountIds) {
    for (const label of Object.values(labelsByAccount[accountId] ?? {})) {
      if (!label.id || !wantedNames.has(label.name.trim())) continue;
      const key = JSON.stringify([accountId, label.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      predicates.push({
        kind: "membership",
        membership: "label",
        id: label.id,
        accountId,
      });
    }
  }

  return {
    kind: "all",
    predicates: [{ kind: "role", role: "inbox" }, anyPredicate(predicates)],
  };
}

/**
 * Drafts, leaving out each account's drafts that a send stands in for. Ids are
 * matched within their own account, as another account's message could share
 * one.
 */
function withoutAccountsHiddenDrafts(hidden: HiddenDrafts[]): MailPredicate {
  // One budget across accounts, as the ids all bind in a single query.
  let remaining = MAX_MESSAGE_PREDICATE_IDS;
  const messagePredicates: MailPredicate[] = [];
  for (const { emailAccountId, messageIds } of hidden) {
    const ids = messageIds.slice(-remaining);
    if (ids.length === 0) continue;
    remaining -= ids.length;
    messagePredicates.push({ kind: "message", accountId: emailAccountId, ids });
  }
  return {
    kind: "all",
    predicates: [
      threadsQueryToPredicate({ type: "draft" }),
      {
        kind: "not",
        predicate: anyPredicate(messagePredicates),
      },
    ],
  };
}

function anyPredicate(predicates: MailPredicate[]): MailPredicate {
  if (predicates.length <= MAX_MAIL_PREDICATE_CHILDREN) {
    return { kind: "any", predicates };
  }
  const chunks: MailPredicate[] = [];
  for (
    let index = 0;
    index < predicates.length;
    index += MAX_MAIL_PREDICATE_CHILDREN
  ) {
    chunks.push({
      kind: "any",
      predicates: predicates.slice(index, index + MAX_MAIL_PREDICATE_CHILDREN),
    });
  }
  return { kind: "any", predicates: chunks };
}
