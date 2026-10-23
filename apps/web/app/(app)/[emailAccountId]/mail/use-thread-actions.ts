"use client";

import { useCallback, useEffect, useRef } from "react";
import { format } from "date-fns";
import groupBy from "lodash/groupBy";
import { toast } from "sonner";
import { toastUndo } from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import {
  type ActionableThread,
  getListThreadEmailAccountId,
  getListThreadKey,
  getListThreadMessageIds,
} from "./types";
import { reportActivationSignal } from "@/hooks/useActivationSignal";
import { useStableCallback } from "./use-stable-callback";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import {
  mutationPayloadToChange,
  type ThreadMutationPayload,
} from "@/utils/mail-engine/mutation-change";
import { submitConversationChanges } from "@/utils/mail-engine/submit-conversations";
import { undoConversationChange } from "@/utils/mail-engine/undo-change";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import {
  observeRumConfirmation,
  recordRumAction,
  recordRumAfterPaint,
} from "@/utils/analytics/rum-actions";

const ENGINE_STARTING = "engine_starting";

const RUM_TRIAGE_ACTIONS: Partial<
  Record<ThreadMutationPayload["kind"], "archive" | "star" | "mark_read">
> = {
  archive: "archive",
  set_starred_state: "star",
  set_read_state: "mark_read",
};

type UndoableAction = "archive" | "unarchive" | "trash" | "snooze";

type ThreadSnapshot = {
  emailAccountId: string;
  /** False when the row showed it outside the inbox; unknown counts as in. */
  inInbox?: boolean;
  key: string;
  messageIds: string[];
  mutationId: string;
  threadId: string;
  /** The row a hidden copy stands behind; unset for the row's own copy. */
  rowKey?: string;
};

type ThreadActionTarget = Omit<ThreadSnapshot, "mutationId"> & {
  copies?: ActionableThread["copies"];
};

// Reading, archiving (and its inverse), snoozing and starring a row that
// stands for one message in several accounts reach every copy, each in its
// own account, so the message behaves as one thing and the row doesn't come
// back from another account; deleting, labelling and moving it stay with the
// copy shown, as changes the user should make there.
const REACHES_COPIES = new Set<ThreadMutationPayload["kind"]>([
  "archive",
  "unarchive",
  "snooze",
  "set_read_state",
  "set_starred_state",
]);

/**
 * What a change to rows did, for a caller that acts on one row at a time and
 * must tell a copy refused in another account from the row itself refused.
 */
export type ThreadActionOutcome = {
  /** Rows changed in every account they are in. */
  rows: string[];
  /** Rows changed in at least one account, so their change can be undone. */
  actedRows: string[];
  /** Accounts where some part of the change wasn't queued. */
  refusedAccountIds: string[];
};

/** A change Catch up makes to its card, reported as a ThreadActionOutcome. */
export type CardChange =
  | { kind: "archive" }
  | { kind: "mark_read" }
  | { kind: "snooze"; until: Date };

type UndoableBatch = {
  action: UndoableAction;
  // Resolves once the engine has admitted the command, so an undo pressed
  // while it is still being admitted waits for it instead of getting lost.
  snapshots: Promise<ThreadSnapshot[]>;
  undone: boolean;
};

export function useThreadActions({
  emailAccountId,
  readerTarget,
  threads,
  onRestored,
}: {
  emailAccountId: string;
  readerTarget?: ThreadActionTarget;
  threads: ActionableThread[];
  /**
   * Called with the keys an undo brought back, for a list that hides removed
   * rows itself rather than following the mail engine's views.
   */
  onRestored?: (threadKeys: string[]) => void;
}) {
  const lastAction = useRef<UndoableBatch | null>(null);
  const restoredListeners = useRef(new Set<(threadKeys: string[]) => void>());
  const notifyRestored = useStableCallback((threadKeys: string[]) => {
    onRestored?.(threadKeys);
    for (const listener of restoredListeners.current) listener(threadKeys);
  });
  // For a part of the view that tracks what it acted on, such as Catch up,
  // to hear an undo from anywhere: its own button, the toast or Z.
  const subscribeRestored = useCallback(
    (listener: (threadKeys: string[]) => void) => {
      restoredListeners.current.add(listener);
      return () => {
        restoredListeners.current.delete(listener);
      };
    },
    [],
  );
  const retainedEmailAccountId = useRef(emailAccountId);
  const listTargetsByKey = useRef(new Map<string, ThreadActionTarget>());
  const activeReaderTarget = useRef<ThreadActionTarget | undefined>(undefined);
  const client = useOptionalMailClient();
  useEffect(() => {
    if (retainedEmailAccountId.current !== emailAccountId) {
      retainedEmailAccountId.current = emailAccountId;
      listTargetsByKey.current.clear();
    }
    activeReaderTarget.current = readerTarget?.messageIds.length
      ? readerTarget
      : undefined;
    rememberTargets(listTargetsByKey.current, threads, emailAccountId);
  }, [emailAccountId, readerTarget, threads]);

  // For conversations acted on from outside the list, such as Catch up's
  // cards, which the list may not have loaded. Copies found either way are
  // kept, so neither the list nor the card loses one the other found.
  const addTargets = useCallback(
    (extra: ActionableThread[]) =>
      rememberTargets(listTargetsByKey.current, extra, emailAccountId, true),
    [emailAccountId],
  );

  const resolveTargets = useCallback(
    (threadKeys: string[]) =>
      threadKeys
        .map((key) => {
          const listTarget = listTargetsByKey.current.get(key);
          if (listTarget) return listTarget;
          return activeReaderTarget.current?.key === key
            ? activeReaderTarget.current
            : undefined;
        })
        .filter((target): target is ThreadActionTarget => Boolean(target)),
    [],
  );

  const enqueueTargets = useCallback(
    async (
      rowTargets: ReturnType<typeof resolveTargets>,
      payload: ThreadMutationPayload,
    ) => {
      const targets = REACHES_COPIES.has(payload.kind)
        ? rowTargets.flatMap((target) => [target, ...copyTargets(target)])
        : rowTargets;
      const nothingQueued = (rejectionCodes: string[]) => ({
        snapshots: [],
        rows: [],
        refusedAccountIds: refusedAccounts(targets, []),
        rejectionCodes,
      });
      if (!targets.length) return nothingQueued([]);
      // The mail screen shows while the engine starts, so a triage can come
      // before there is anything to queue it on.
      if (!client) return nothingQueued([ENGINE_STARTING]);
      const change = mutationPayloadToChange(payload);
      if (!change) return nothingQueued([]);
      const startedAt = performance.now();
      const rumAction = RUM_TRIAGE_ACTIONS[payload.kind];
      // The first command registers its optimistic change before its first
      // await, so the row has changed by the time this frame is painted.
      if (rumAction) recordRumAfterPaint(`${rumAction}_optimistic`, startedAt);
      const snapshots: ThreadSnapshot[] = [];
      const rejectionCodes: string[] = [];
      // Each account's submit runs synchronously up to its first await, and
      // submitConversationChanges registers its optimistic change before
      // that, so every account's change shows in this same task and a row's
      // hidden copies change with it. One account failing leaves the others'
      // changes recorded: their rows read as failed, yet stay undoable.
      await Promise.allSettled(
        Object.entries(groupBy(targets, (target) => target.emailAccountId)).map(
          async ([accountId, accountTargets]) => {
            const result = await submitConversationChanges({
              accountId,
              change,
              client,
              conversationIds: accountTargets.map((target) => target.threadId),
            });
            rejectionCodes.push(...result.rejectionCodes);
            const commandIds = new Map(
              result.accepted.map((item) => [
                item.conversationId,
                item.commandId,
              ]),
            );
            // A bulk change is one batch: the account's last command ending is
            // when the server has all of it, so one observation covers it.
            const lastCommandId = result.accepted.at(-1)?.commandId;
            if (rumAction && lastCommandId) {
              observeRumConfirmation({
                client,
                accountId,
                operationId: lastCommandId,
                name: `${rumAction}_confirmed`,
                startedAt,
              });
            }
            for (const { copies: _copies, ...target } of accountTargets) {
              const mutationId = commandIds.get(target.threadId);
              if (mutationId) snapshots.push({ ...target, mutationId });
            }
          },
        ),
      );
      if (rumAction && rejectionCodes.length) {
        recordRumAction(`${rumAction}_confirmed`, startedAt, "error");
      }
      if (payload.kind === "archive" || payload.kind === "snooze") {
        for (const accountId of new Set(
          snapshots.map((snapshot) => snapshot.emailAccountId),
        ))
          reportActivationSignal(accountId, "first_triage_action");
      }
      return {
        snapshots,
        rows: completeRows(targets, snapshots),
        refusedAccountIds: refusedAccounts(targets, snapshots),
        rejectionCodes,
      };
    },
    [client],
  );

  // A retry or another tab taking over can replace the engine, and an undo
  // (the shortcut, or a toast shown before) must reach the one running now.
  // Batches carry their own accounts, so the last one stays undoable across
  // an account switch.
  const undoBatch = useStableCallback(async (batch: UndoableBatch) => {
    if (batch.undone || !client) return [];
    batch.undone = true;
    if (lastAction.current === batch) lastAction.current = null;
    const snapshots = await batch.snapshots;
    if (!snapshots.length) return [];

    const results = await Promise.allSettled(
      Object.values(groupBy(snapshots, (snapshot) => snapshot.mutationId)).map(
        async (snapshots) => {
          const { emailAccountId, mutationId } = snapshots[0];
          const compensations = Object.values(
            groupBy(snapshots, (snapshot) =>
              UNDOABLE_COPY[batch.action].compensation(snapshot),
            ),
          ).map((group) => {
            const change = mutationPayloadToChange({
              kind: UNDOABLE_COPY[batch.action].compensation(group[0]),
            });
            if (!change) throw new Error("no_compensation");
            return {
              conversationIds: group.map((snapshot) => snapshot.threadId),
              change,
            };
          });
          await undoConversationChange({
            client,
            accountId: emailAccountId,
            operationId: mutationId,
            compensations,
          });
          return snapshots;
        },
      ),
    );
    const restoredKeys = completeRows(
      snapshots,
      results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    );
    const failedCount = rowKeys(snapshots).length - restoredKeys.length;

    if (restoredKeys.length) {
      notifyRestored(restoredKeys);
      toast.success(summarise("Restored", restoredKeys.length));
    }
    if (failedCount) {
      toast.error(
        failedCount === rowKeys(snapshots).length
          ? "Couldn't restore"
          : `Couldn't restore ${failedCount} of ${rowKeys(snapshots).length}`,
      );
    }
    if (!restoredKeys.length) {
      batch.undone = false;
      // An action taken while this undo ran is now the one to undo.
      if (lastAction.current === null) lastAction.current = batch;
    }
    return restoredKeys;
  });

  const undo = useCallback(async () => {
    const batch = lastAction.current;
    return batch ? undoBatch(batch) : [];
  }, [undoBatch]);

  const runUndoable = useCallback(
    async (
      payload: Extract<ThreadMutationPayload, { kind: UndoableAction }>,
      threadKeys: string[],
    ) => {
      const action = payload.kind;
      const targets = resolveTargets(threadKeys);
      const enqueued = enqueueTargets(targets, payload);
      // The row leaves on the keypress, before the engine admits the command,
      // so the batch is the one to undo from that moment on.
      const previous = lastAction.current;
      const batch: UndoableBatch = {
        action,
        snapshots: enqueued.then(
          (result) => result.snapshots,
          () => [],
        ),
        undone: false,
      };
      lastAction.current = batch;
      const { rows, snapshots, refusedAccountIds, rejectionCodes } =
        await enqueued.catch((error) => {
          if (lastAction.current === batch) lastAction.current = previous;
          throw error;
        });
      const outcome: ThreadActionOutcome = {
        rows,
        actedRows: rowKeys(snapshots),
        refusedAccountIds,
      };
      if (!rows.length) {
        // Copies that did change stay undoable with the shortcut.
        if (!snapshots.length && lastAction.current === batch)
          lastAction.current = previous;
        if (threadKeys.length) {
          toast.error(
            enqueueFailureCopy(
              `Couldn't queue ${UNDOABLE_COPY[action].noun}`,
              rejectionCodes,
            ),
          );
        }
        return outcome;
      }

      const failedCount = threadKeys.length - rows.length;
      toastUndo({
        message: UNDOABLE_COPY[action].done(rows.length, payload),
        shortcut: getShortcutHint("undo"),
        onUndo: () => {
          undoBatch(batch);
        },
      });
      if (failedCount) {
        toast.error(
          enqueueFailureCopy(
            `Couldn't queue ${failedCount} of ${threadKeys.length} for ${UNDOABLE_COPY[action].noun}`,
            rejectionCodes,
          ),
        );
      }
      return outcome;
    },
    [enqueueTargets, resolveTargets, undoBatch],
  );

  const changeReadState = useCallback(
    async (
      threadKeys: string[],
      read: boolean,
      notifySuccess: boolean,
    ): Promise<ThreadActionOutcome> => {
      const targets = resolveTargets(threadKeys);
      const { rows, snapshots, refusedAccountIds, rejectionCodes } =
        await enqueueTargets(targets, {
          kind: "set_read_state",
          read,
        });
      const failedCount = threadKeys.length - rows.length;
      if (rows.length && notifySuccess) {
        toast.success(
          rows.length === 1
            ? `Marked as ${read ? "read" : "unread"}`
            : `Marked ${rows.length} conversations as ${read ? "read" : "unread"}`,
        );
      }
      if (failedCount) {
        toast.error(
          enqueueFailureCopy(
            failedCount === threadKeys.length
              ? `Couldn't queue marking as ${read ? "read" : "unread"}`
              : `Couldn't queue ${failedCount} of ${threadKeys.length} as ${read ? "read" : "unread"}`,
            rejectionCodes,
          ),
        );
      }
      return { rows, actedRows: rowKeys(snapshots), refusedAccountIds };
    },
    [enqueueTargets, resolveTargets],
  );

  const setReadState = useCallback(
    async (threadKeys: string[], read: boolean, notifySuccess = true) =>
      (await changeReadState(threadKeys, read, notifySuccess)).rows,
    [changeReadState],
  );

  const setStarredState = useCallback(
    async (threadKeys: string[], starred: boolean) => {
      const { rows, rejectionCodes } = await enqueueTargets(
        resolveTargets(threadKeys),
        {
          kind: "set_starred_state",
          starred,
        },
      );
      if (rows.length < threadKeys.length) {
        toast.error(
          enqueueFailureCopy(
            "Couldn’t update stars for all conversations",
            rejectionCodes,
          ),
        );
      }
      return rows;
    },
    [enqueueTargets, resolveTargets],
  );

  const snooze = useCallback(
    async (threadKeys: string[], snoozedUntil: Date) =>
      (
        await runUndoable(
          { kind: "snooze", scheduledFor: snoozedUntil.toISOString() },
          threadKeys,
        )
      ).rows,
    [runUndoable],
  );

  const changeCard = useCallback(
    (threadKeys: string[], change: CardChange) => {
      if (change.kind === "mark_read")
        return changeReadState(threadKeys, true, false);
      if (change.kind === "archive")
        return runUndoable({ kind: "archive" }, threadKeys);
      return runUndoable(
        { kind: "snooze", scheduledFor: change.until.toISOString() },
        threadKeys,
      );
    },
    [changeReadState, runUndoable],
  );

  const markSpam = useCallback(
    async (threadKeys: string[]) => {
      const targets = resolveTargets(threadKeys);
      const { snapshots, rejectionCodes } = await enqueueTargets(targets, {
        kind: "spam",
      });
      const failedCount = threadKeys.length - snapshots.length;
      if (snapshots.length) {
        toast.success(
          snapshots.length === 1
            ? "Marked as spam"
            : `Marked ${snapshots.length} conversations as spam`,
        );
      }
      if (failedCount) {
        toast.error(
          enqueueFailureCopy(
            failedCount === threadKeys.length
              ? "Couldn't queue marking as spam"
              : `Couldn't queue ${failedCount} of ${threadKeys.length} as spam`,
            rejectionCodes,
          ),
        );
      }
      return snapshots.map((snapshot) => snapshot.key);
    },
    [enqueueTargets, resolveTargets],
  );

  const runWithToast = useCallback(
    async (
      threadKeys: string[],
      payload: ThreadMutationPayload,
      copy: { done: (count: number) => string; failed: string },
    ) => {
      const { snapshots, rejectionCodes } = await enqueueTargets(
        resolveTargets(threadKeys),
        payload,
      );
      if (snapshots.length) toast.success(copy.done(snapshots.length));
      if (snapshots.length < threadKeys.length) {
        toast.error(enqueueFailureCopy(copy.failed, rejectionCodes));
      }
      return snapshots.map((snapshot) => snapshot.key);
    },
    [enqueueTargets, resolveTargets],
  );

  const markNotSpam = useCallback(
    (threadKeys: string[]) =>
      runWithToast(
        threadKeys,
        { kind: "not_spam" },
        {
          done: (count) =>
            count === 1
              ? "Moved to inbox"
              : `Moved ${count} conversations to inbox`,
          failed: "Couldn't queue marking as not spam",
        },
      ),
    [runWithToast],
  );

  const restoreFromTrash = useCallback(
    (threadKeys: string[]) =>
      runWithToast(
        threadKeys,
        { kind: "untrash" },
        {
          done: (count) => summarise("Restored", count),
          failed: "Couldn't queue restoring",
        },
      ),
    [runWithToast],
  );

  const setImportantState = useCallback(
    (threadKeys: string[], important: boolean) =>
      runWithToast(
        threadKeys,
        { kind: "set_important_state", important },
        {
          done: (count) =>
            `Marked ${count === 1 ? "" : `${count} conversations `}as ${important ? "important" : "not important"}`,
          failed: "Couldn't queue changing importance",
        },
      ),
    [runWithToast],
  );

  return {
    addTargets,
    changeCard,
    subscribeRestored,
    archive: useCallback(
      async (threadKeys: string[]) =>
        (await runUndoable({ kind: "archive" }, threadKeys)).rows,
      [runUndoable],
    ),
    moveToInbox: useCallback(
      async (threadKeys: string[]) =>
        (await runUndoable({ kind: "unarchive" }, threadKeys)).rows,
      [runUndoable],
    ),
    trash: useCallback(
      async (threadKeys: string[]) =>
        (await runUndoable({ kind: "trash" }, threadKeys)).rows,
      [runUndoable],
    ),
    markRead: useCallback(
      (threadKeys: string[]) => setReadState(threadKeys, true, false),
      [setReadState],
    ),
    markSpam,
    markNotSpam,
    restoreFromTrash,
    setImportantState,
    setReadState,
    setStarredState,
    snooze,
    undo,
  };
}

const UNDOABLE_COPY: Record<
  UndoableAction,
  {
    compensation: (
      snapshot: ThreadSnapshot,
    ) => "archive" | "unarchive" | "untrash";
    done: (count: number, payload: ThreadMutationPayload) => string;
    noun: string;
  }
> = {
  archive: {
    compensation: () => "unarchive",
    done: (count) => summarise("Archived", count),
    noun: "archiving",
  },
  unarchive: {
    compensation: () => "archive",
    done: (count) =>
      count === 1 ? "Moved to inbox" : `Moved ${count} conversations to inbox`,
    noun: "moving to inbox",
  },
  trash: {
    compensation: () => "untrash",
    done: (count) => summarise("Deleted", count),
    noun: "deletion",
  },
  // Both end the snooze on the server, so it is put back where it was.
  snooze: {
    compensation: (snapshot) =>
      snapshot.inInbox === false ? "archive" : "unarchive",
    done: (count, payload) =>
      count === 1 && payload.kind === "snooze"
        ? `Snoozed until ${format(new Date(payload.scheduledFor), "EEE, MMM d 'at' p")}`
        : `Snoozed ${count} conversations`,
    noun: "snoozing",
  },
};

function copyTargets(target: ThreadActionTarget): ThreadActionTarget[] {
  return (target.copies ?? []).map((copy) => ({
    emailAccountId: copy.accountId,
    key: `${copy.accountId}:${copy.threadId}`,
    inInbox: copy.inInbox,
    messageIds: [],
    threadId: copy.threadId,
    rowKey: target.key,
  }));
}

/** Accounts holding a target whose change wasn't queued. */
function refusedAccounts(
  targets: Pick<ThreadSnapshot, "key" | "emailAccountId">[],
  snapshots: Pick<ThreadSnapshot, "key">[],
) {
  const queued = new Set(snapshots.map((snapshot) => snapshot.key));
  return [
    ...new Set(
      targets
        .filter((target) => !queued.has(target.key))
        .map((target) => target.emailAccountId),
    ),
  ];
}

/**
 * The rows whose own copy and every hidden copy are in `done`: a row half
 * changed in another account isn't one the user asked for.
 */
function completeRows(
  expected: Pick<ThreadSnapshot, "key" | "rowKey">[],
  done: Pick<ThreadSnapshot, "key">[],
) {
  const doneKeys = new Set(done.map((item) => item.key));
  const missing = new Set(
    expected
      .filter((item) => !doneKeys.has(item.key))
      .map((item) => item.rowKey ?? item.key),
  );
  return rowKeys(expected).filter((row) => !missing.has(row));
}

/** The rows changed: a row's hidden copies count with it. */
function rowKeys(snapshots: Pick<ThreadSnapshot, "key" | "rowKey">[]) {
  return [
    ...new Set(snapshots.map((snapshot) => snapshot.rowKey ?? snapshot.key)),
  ];
}

/**
 * Remembers each thread's target. With `merge`, a target already known keeps
 * the message ids and copies it had, so an extra source of a row never drops
 * a copy the list found, nor the other way round.
 */
function rememberTargets(
  targets: Map<string, ThreadActionTarget>,
  threads: ActionableThread[],
  emailAccountId: string,
  merge = false,
) {
  for (const thread of threads) {
    const messageIds = [...new Set(getListThreadMessageIds(thread))];
    if (!messageIds.length) continue;
    const key = getListThreadKey(thread);
    const labelled = thread.messages?.filter((message) => message.labelIds);
    const inInbox =
      thread.inInbox ??
      (labelled?.length
        ? labelled.some((message) => message.labelIds?.includes("INBOX"))
        : undefined);
    const known = merge ? targets.get(key) : undefined;
    const copies = new Map(
      [...(known?.copies ?? []), ...(thread.copies ?? [])].map((copy) => [
        `${copy.accountId}:${copy.threadId}`,
        copy,
      ]),
    );
    targets.set(key, {
      emailAccountId: getListThreadEmailAccountId(thread, emailAccountId),
      inInbox: inInbox ?? known?.inInbox,
      key,
      messageIds: [...new Set([...(known?.messageIds ?? []), ...messageIds])],
      threadId: thread.id,
      copies: copies.size ? [...copies.values()] : undefined,
    });
  }
}

function summarise(verb: string, count: number) {
  return count === 1 ? verb : `${verb} ${count} conversations`;
}

function enqueueFailureCopy(generic: string, rejectionCodes: string[]) {
  if (rejectionCodes[0] === ENGINE_STARTING) {
    return "Mail is still starting. Try again in a moment.";
  }
  return admissionRejectionCopy(rejectionCodes[0]) ?? generic;
}
