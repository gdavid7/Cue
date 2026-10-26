"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";
import type {
  ConversationQuery,
  LeftOpenDraft,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import {
  type HiddenDrafts,
  useAllAccountsHiddenDraftMessageIds,
} from "@/hooks/useHiddenDraftMessageIds";
import type { CueAuthoredDraftsResponse } from "@/app/api/user/cue-authored-drafts/route";
import { fetchForAccounts } from "@/utils/fetch-for-accounts";
import type { TodayAccount } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

/** A draft saved more recently than this is still being written. */
export const LEFT_OPEN_AFTER_MS = 60 * 60_000;
export const LEFT_OPEN_SHOWN_LIMIT = 5;
// Past what shows, so drafts a send stands in for don't empty the lane, and
// one more says there are more.
const READ_LIMIT = 20;
const NO_DRAFTS: LeftOpenDraft[] = [];
const CUE_AUTHORED_DRAFTS_PATH = "/api/user/cue-authored-drafts";

/**
 * Today's "Drafts you left open": unsent mailbox drafts the user last saved
 * over an hour ago, newest first, read from this browser's local mail with no
 * model. Cue's reply suggestions aren't mailbox drafts until the user edits
 * one, so they never show here; the drafts Cue does write into the mailbox,
 * such as follow-ups, are left out by the ids the server keeps for them, and
 * a draft shows only once the server has said it isn't one of them. A draft
 * that a send waiting to go out stands in for is the send's, not left open.
 * Once every account's first sync has finished, so a draft isn't shown and
 * then found sent.
 */
export function useLeftOpenDrafts({ accounts }: { accounts: TodayAccount[] }): {
  drafts: LeftOpenDraft[];
  capped: boolean;
} {
  const client = useOptionalMailClient();
  // A tab relaying an older engine, the in-tab fallback and the desktop
  // bridge may not answer it.
  const queryLeftOpenDrafts = mailClientSupports(
    client,
    "method:queryLeftOpenDrafts",
  )
    ? client?.queryLeftOpenDrafts?.bind(client)
    : undefined;
  const active = Boolean(queryLeftOpenDrafts) && accounts.length > 0;
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  // The newest draft: says whether the store is ready, and its revision
  // moves when a draft is saved, sent or discarded, which reads again.
  const latestDraft = useMailboxWindow(
    useMemo<ConversationQuery>(
      () => ({
        accountIds,
        predicate: { kind: "mailbox", mailbox: "drafts" },
        order: "newest_first",
        pageSize: 1,
        after: null,
      }),
      [accountIds],
    ),
    { client, enabled: active },
  );
  const ready =
    active &&
    latestDraft.status === "ready" &&
    Boolean(latestDraft.data && isLocalMailReady(latestDraft.data, accounts));
  const hidden = useAllAccountsHiddenDraftMessageIds(
    active ? accounts : undefined,
  );

  const { data } = useSWR(
    ready && queryLeftOpenDrafts
      ? [
          "left-open-drafts",
          accountIds.join(","),
          latestDraft.revision?.databaseEpoch,
          latestDraft.revision?.sequence,
        ]
      : null,
    () =>
      queryLeftOpenDrafts?.({
        accountIds,
        savedBeforeMs: Date.now() - LEFT_OPEN_AFTER_MS,
        limit: READ_LIMIT,
      }) ?? NO_DRAFTS,
    {
      keepPreviousData: true,
      // Focus is when an hour may have passed since the last read.
      revalidateOnFocus: true,
      // An older tab owning the engine answers "unsupported"; asking again
      // won't change that.
      shouldRetryOnError: false,
    },
  );

  const read = ready && data ? data : NO_DRAFTS;
  // Each account is asked about only its drafts the lane could show, and
  // again only when those change, as each ask may read Cue's drafts from
  // the mailbox.
  const requests = useMemo(() => cueAuthoredRequests(read), [read]);
  const { data: cueAuthored } = useSWR(
    requests.length
      ? [
          CUE_AUTHORED_DRAFTS_PATH,
          ...requests.flatMap((r) => [r.accountId, r.path]),
        ]
      : null,
    async () => {
      const paths = new Map(requests.map((r) => [r.accountId, r.path]));
      const result = await fetchForAccounts<CueAuthoredDraftsResponse>(
        (accountId) => paths.get(accountId) ?? CUE_AUTHORED_DRAFTS_PATH,
        [...paths.keys()],
      );
      return {
        ...result,
        checked: new Set(requests.flatMap((r) => r.draftKeys)),
      };
    },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // The key changes whenever the drafts do; a mount with the same ones
      // needn't read the mailbox again.
      revalidateIfStale: false,
    },
  );

  return useMemo(() => {
    if (!cueAuthored) return selectLeftOpenDrafts(NO_DRAFTS, hidden);
    // A draft the server hasn't answered for, or whose account it couldn't
    // answer for, may be Cue's.
    const checked = read.filter(
      (draft) =>
        cueAuthored.checked.has(draftKey(draft)) &&
        !cueAuthored.failedAccountIds.includes(draft.accountId),
    );
    return selectLeftOpenDrafts(checked, [
      ...hidden,
      ...cueAuthored.byAccount.map(({ accountId, data }) => ({
        emailAccountId: accountId,
        messageIds: data.messageIds,
      })),
    ]);
  }, [read, hidden, cueAuthored]);
}

/**
 * What the lane shows of what the store read: none a send stands in for or
 * Cue wrote, up to the lane's cap, and whether there were more.
 */
export function selectLeftOpenDrafts(
  drafts: LeftOpenDraft[],
  hidden: HiddenDrafts[],
) {
  const hiddenIds = new Set(
    hidden.flatMap(({ emailAccountId, messageIds }) =>
      messageIds.map((id) => `${emailAccountId}\0${id}`),
    ),
  );
  const open = drafts.filter((draft) => !hiddenIds.has(draftKey(draft)));
  return {
    drafts: open.slice(0, LEFT_OPEN_SHOWN_LIMIT),
    capped: open.length > LEFT_OPEN_SHOWN_LIMIT,
  };
}

function draftKey(draft: LeftOpenDraft) {
  return `${draft.accountId}\0${draft.messageId}`;
}

function cueAuthoredRequests(drafts: LeftOpenDraft[]) {
  const byAccount = new Map<string, LeftOpenDraft[]>();
  for (const draft of drafts)
    byAccount.set(draft.accountId, [
      ...(byAccount.get(draft.accountId) ?? []),
      draft,
    ]);
  return [...byAccount]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountId, accountDrafts]) => {
      const sorted = [...accountDrafts].sort((a, b) =>
        a.messageId.localeCompare(b.messageId),
      );
      const savedAt = sorted.map((draft) => draft.savedAtMs);
      const params = new URLSearchParams({
        items: sorted
          .map((draft) => `${draft.conversationId}:${draft.messageId}`)
          .join(","),
        savedFromMs: String(Math.min(...savedAt)),
        savedToMs: String(Math.max(...savedAt)),
      });
      return {
        accountId,
        path: `${CUE_AUTHORED_DRAFTS_PATH}?${params}`,
        draftKeys: sorted.map(draftKey),
      };
    });
}
