"use client";

import { useEffect, useMemo } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
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
import type { ThreadsQuery } from "@/utils/threads/validation";

const EMPTY_LABELS_BY_ACCOUNT: Record<string, EmailLabels> = {};
const MAX_MAIL_PREDICATE_CHILDREN = 32;

export function useCombinedMailThreads({
  accounts,
  emailAccountId,
  enabled,
  isUnread,
  labelNames,
  searchQuery,
  providerSearch,
}: {
  accounts: AllInboxesAccount[];
  emailAccountId: string;
  enabled: boolean;
  isUnread: boolean;
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
  const predicate = useMemo(
    () =>
      labelNames?.length
        ? labelNamesToAccountScopedPredicate({
            accountIds,
            labelsByAccount,
            labelNames,
          })
        : undefined,
    [accountIds, labelNames, labelsByAccount],
  );
  const query = useMemo<ThreadsQuery>(() => {
    if (searchQuery) return { q: searchQuery };
    if (labelNames?.length) {
      return { type: "inbox" };
    }
    if (isUnread) return { type: "unread" };
    return { type: "inbox" };
  }, [isUnread, labelNames, searchQuery]);
  const state = useEngineMailThreads({
    emailAccountId,
    accountIds: accountIds.length ? accountIds : [emailAccountId],
    accounts: accountsById,
    query,
    predicate: searchQuery ? undefined : predicate,
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
  Promise.all(
    accounts.map((account) =>
      client.ensureAccount?.({
        accountId: account.id,
        provider: isMicrosoftProvider(account.provider)
          ? "microsoft"
          : "google",
      }),
    ),
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
          const response = (await fetcher(["/api/labels", accountId])) as
            | LabelsResponse
            | undefined;
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
