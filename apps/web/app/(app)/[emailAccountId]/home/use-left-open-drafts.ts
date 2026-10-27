"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
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
const NO_ANSWERS: ReadonlyMap<string, boolean> = new Map();
const CUE_AUTHORED_DRAFTS_PATH = "/api/user/cue-authored-drafts";
// How often, and from how long after, an account the server couldn't answer
// for is asked again: past a typical Gmail deferral, then doubling.
export const CUE_AUTHORED_RECOVERIES = 3;
export const CUE_AUTHORED_RECOVERY_MS = 30_000;

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
  // This tab's answer for each draft as last saved, so a draft that ages in
  // or is saved again asks the server about it alone: each ask may read
  // Cue's drafts from the mailbox. Message ids and save times only.
  const { data: answers = NO_ANSWERS, mutate: mutateAnswers } = useSWR<
    ReadonlyMap<string, boolean>
  >(["left-open-cue-answers", accountIds.join(",")], null);
  const answersRef = useRef(answers);
  const readRef = useRef(read);
  useEffect(() => {
    answersRef.current = answers;
    readRef.current = read;
  });
  const recordAnswers = useCallback(
    (answered: Map<string, boolean>) =>
      mutateAnswers(
        (previous) => {
          // Only the drafts the lane could still show.
          const current = new Set(readRef.current.map(answerKey));
          const next = new Map(
            [...(previous ?? NO_ANSWERS)].filter(([key]) => current.has(key)),
          );
          for (const [key, cueAuthored] of answered) next.set(key, cueAuthored);
          return next;
        },
        { revalidate: false },
      ),
    [mutateAnswers],
  );

  // Moves whenever a draft the lane could show does; a revision that moves
  // no draft's save asks nothing.
  const draftsKey = read.map(answerKey).sort().join("\n");
  const { data: asked, mutate: mutateAsked } = useSWR(
    read.length ? [CUE_AUTHORED_DRAFTS_PATH, draftsKey] : null,
    async () => {
      // This render's drafts: the refs catch up only after SWR starts this.
      const result = await askCueAuthored(
        cueAuthoredRequests(unanswered(read, answers)),
      );
      await recordAnswers(result.answers);
      return {
        retryAccountIds: result.retryAccountIds,
        draftsKey,
        recoveries: 0,
      };
    },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // The key changes whenever the drafts do; a mount with the same ones
      // needn't read the mailbox again.
      revalidateIfStale: false,
      // Recovery below asks again, only for the accounts that failed and
      // only a few times, so a busy Gmail account isn't asked without end.
      shouldRetryOnError: false,
    },
  );

  // An account the server couldn't answer for, such as one Gmail deferred,
  // is asked again a few times, further apart each time, while its drafts
  // stay hidden.
  useEffect(() => {
    if (!asked?.retryAccountIds.length) return;
    if (asked.recoveries >= CUE_AUTHORED_RECOVERIES) return;
    // Still the previous drafts' answer while theirs loads.
    if (asked.draftsKey !== draftsKey) return;
    const retry = new Set(asked.retryAccountIds);
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        const retried = await askCueAuthored(
          cueAuthoredRequests(
            unanswered(readRef.current, answersRef.current).filter((draft) =>
              retry.has(draft.accountId),
            ),
          ),
        );
        if (cancelled) return;
        recordAnswers(retried.answers);
        mutateAsked(
          {
            ...asked,
            retryAccountIds: retried.retryAccountIds,
            recoveries: asked.recoveries + 1,
          },
          { revalidate: false },
        );
      },
      CUE_AUTHORED_RECOVERY_MS * 2 ** asked.recoveries,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [asked, draftsKey, mutateAsked, recordAnswers]);

  return useMemo(
    () =>
      // A draft shows only once the server has said that, as last saved,
      // it isn't Cue's.
      selectLeftOpenDrafts(
        read.filter((draft) => answers.get(answerKey(draft)) === false),
        hidden,
      ),
    [read, hidden, answers],
  );
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

/** A draft as last saved: one saved again is asked about again. */
function answerKey(draft: LeftOpenDraft) {
  return `${draftKey(draft)}\0${draft.savedAtMs}`;
}

function unanswered(
  drafts: LeftOpenDraft[],
  answers: ReadonlyMap<string, boolean>,
) {
  return drafts.filter((draft) => !answers.has(answerKey(draft)));
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
      const params = new URLSearchParams({
        items: sorted
          .map((draft) => `${draft.conversationId}:${draft.messageId}`)
          .join(","),
        savedAtMs: sorted.map((draft) => draft.savedAtMs).join(","),
      });
      return {
        accountId,
        path: `${CUE_AUTHORED_DRAFTS_PATH}?${params}`,
        drafts: sorted,
      };
    });
}

/**
 * Every account's answer for each draft the server checked, each account
 * asked alone so its failure keeps its status. A failed account answers
 * for none of its drafts, and is listed to retry unless the server said
 * asking again won't help.
 */
async function askCueAuthored(
  requests: ReturnType<typeof cueAuthoredRequests>,
) {
  const answers = new Map<string, boolean>();
  const retryAccountIds: string[] = [];
  await Promise.all(
    requests.map(async ({ accountId, path, drafts }) => {
      try {
        const { byAccount } = await fetchForAccounts<CueAuthoredDraftsResponse>(
          path,
          [accountId],
        );
        const data = byAccount.find((a) => a.accountId === accountId)?.data;
        if (!data) {
          retryAccountIds.push(accountId);
          return;
        }
        const checked = new Set(data.checkedMessageIds);
        const cueAuthored = new Set(data.messageIds);
        for (const draft of drafts)
          if (checked.has(draft.messageId))
            answers.set(answerKey(draft), cueAuthored.has(draft.messageId));
      } catch (error) {
        if ((error as { status?: number })?.status !== 409)
          retryAccountIds.push(accountId);
      }
    }),
  );
  return { answers, retryAccountIds };
}
