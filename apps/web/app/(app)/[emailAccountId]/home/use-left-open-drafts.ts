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
import type { TodayAccount } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

/** A draft saved more recently than this is still being written. */
export const LEFT_OPEN_AFTER_MS = 60 * 60_000;
export const LEFT_OPEN_SHOWN_LIMIT = 5;
// Past what shows, so drafts a send stands in for don't empty the lane, and
// one more says there are more.
const READ_LIMIT = 20;
const NO_DRAFTS: LeftOpenDraft[] = [];

/**
 * Today's "Drafts you left open": unsent mailbox drafts the user last saved
 * over an hour ago, newest first, read from this browser's local mail with no
 * model and no server. Cue's reply suggestions aren't mailbox drafts until
 * the user edits one, so they never show here. A draft that a send waiting to
 * go out stands in for is the send's, not left open. Once every account's
 * first sync has finished, so a draft isn't shown and then found sent.
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
  return useMemo(() => selectLeftOpenDrafts(read, hidden), [read, hidden]);
}

/**
 * What the lane shows of what the store read: none a send stands in for, up
 * to the lane's cap, and whether there were more.
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
  const open = drafts.filter(
    (draft) => !hiddenIds.has(`${draft.accountId}\0${draft.messageId}`),
  );
  return {
    drafts: open.slice(0, LEFT_OPEN_SHOWN_LIMIT),
    capped: open.length > LEFT_OPEN_SHOWN_LIMIT,
  };
}
