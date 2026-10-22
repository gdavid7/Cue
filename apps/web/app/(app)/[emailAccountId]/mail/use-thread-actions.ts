"use client";

import { useCallback, useEffect, useRef } from "react";
import { format } from "date-fns";
import groupBy from "lodash/groupBy";
import { toast } from "sonner";
import { toastUndo } from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import { randomUuid } from "@/utils/uuid";
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

type UndoableAction = "archive" | "unarchive" | "trash";

type ThreadSnapshot = {
  emailAccountId: string;
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

// Reading, archiving (and its inverse) and starring a row that stands for one
// message in several accounts reach every copy, each in its own account, so
// the row doesn't come back from another account; deleting, labelling and
// moving it stay with the copy shown, as changes the user should make there.
const REACHES_COPIES = new Set<ThreadMutationPayload["kind"]>([
  "archive",
  "unarchive",
  "set_read_state",
  "set_starred_state",
]);

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
  const notifyRestored = useStableCallback((threadKeys: string[]) =>
    onRestored?.(threadKeys),
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
    for (const thread of threads) {
      const messageIds = [...new Set(getListThreadMessageIds(thread))];
      if (!messageIds.length) continue;
      const key = getListThreadKey(thread);
      listTargetsByKey.current.set(key, {
        emailAccountId: getListThreadEmailAccountId(thread, emailAccountId),
        key,
        messageIds,
        threadId: thread.id,
        copies: thread.copies,
      });
    }
  }, [emailAccountId, readerTarget, threads]);

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
      if (!targets.length)
        return { snapshots: [], rows: [], rejectionCodes: [] };
      // The mail screen shows while the engine starts, so a triage can come
      // before there is anything to queue it on.
      if (!client)
        return {
          snapshots: [],
          rows: [],
          rejectionCodes: [ENGINE_STARTING],
        };
      const change = mutationPayloadToChange(payload);
      if (!change) return { snapshots: [], rows: [], rejectionCodes: [] };
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

    const compensation = mutationPayloadToChange({
      kind: UNDOABLE_COPY[batch.action].compensation,
    });
    if (!compensation) return [];
    const results = await Promise.allSettled(
      Object.values(groupBy(snapshots, (snapshot) => snapshot.mutationId)).map(
        async (snapshots) => {
          const { emailAccountId, mutationId } = snapshots[0];
          const cancelled =
            (
              await client.cancelOperation({
                accountId: emailAccountId,
                operationId: mutationId,
              })
            ).status === "cancelled";
          if (!cancelled) {
            const diagnostics = await client.getDiagnostics(emailAccountId);
            const admission = await client.submitConversations({
              accountId: emailAccountId,
              commandId: randomUuid(),
              conversations: snapshots.map((snapshot) => ({
                accountId: emailAccountId,
                conversationId: snapshot.threadId,
              })),
              change: compensation,
              observedRevision: diagnostics.revision,
            });
            if (admission.status === "rejected") {
              throw new Error(admission.code);
            }
          }
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
    async (action: UndoableAction, threadKeys: string[]) => {
      const targets = resolveTargets(threadKeys);
      const enqueued = enqueueTargets(targets, { kind: action });
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
      const { rows, snapshots, rejectionCodes } = await enqueued.catch(
        (error) => {
          if (lastAction.current === batch) lastAction.current = previous;
          throw error;
        },
      );
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
        return [];
      }

      const failedCount = threadKeys.length - rows.length;
      toastUndo({
        message: UNDOABLE_COPY[action].done(rows.length),
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
      return rows;
    },
    [enqueueTargets, resolveTargets, undoBatch],
  );

  const setReadState = useCallback(
    async (threadKeys: string[], read: boolean, notifySuccess = true) => {
      const targets = resolveTargets(threadKeys);
      const { rows, rejectionCodes } = await enqueueTargets(targets, {
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
      return rows;
    },
    [enqueueTargets, resolveTargets],
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
    async (threadKeys: string[], snoozedUntil: Date) => {
      const targets = resolveTargets(threadKeys);
      const { snapshots, rejectionCodes } = await enqueueTargets(targets, {
        kind: "snooze",
        scheduledFor: snoozedUntil.toISOString(),
      });
      const failedCount = threadKeys.length - snapshots.length;
      if (snapshots.length) {
        toast.success(
          snapshots.length === 1
            ? `Snoozed until ${format(snoozedUntil, "EEE, MMM d 'at' p")}`
            : `Snoozed ${snapshots.length} conversations`,
        );
      }
      if (failedCount) {
        toast.error(
          enqueueFailureCopy(
            failedCount === threadKeys.length
              ? threadKeys.length === 1
                ? "Couldn't queue snoozing"
                : "Couldn't queue snoozing conversations"
              : `Couldn't queue ${failedCount} of ${threadKeys.length} for snoozing`,
            rejectionCodes,
          ),
        );
      }
      return snapshots.map((snapshot) => snapshot.key);
    },
    [enqueueTargets, resolveTargets],
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
    archive: useCallback(
      (threadKeys: string[]) => runUndoable("archive", threadKeys),
      [runUndoable],
    ),
    moveToInbox: useCallback(
      (threadKeys: string[]) => runUndoable("unarchive", threadKeys),
      [runUndoable],
    ),
    trash: useCallback(
      (threadKeys: string[]) => runUndoable("trash", threadKeys),
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
    compensation: "archive" | "unarchive" | "untrash";
    done: (count: number) => string;
    noun: string;
  }
> = {
  archive: {
    compensation: "unarchive",
    done: (count) => summarise("Archived", count),
    noun: "archiving",
  },
  unarchive: {
    compensation: "archive",
    done: (count) =>
      count === 1 ? "Moved to inbox" : `Moved ${count} conversations to inbox`,
    noun: "moving to inbox",
  },
  trash: {
    compensation: "untrash",
    done: (count) => summarise("Deleted", count),
    noun: "deletion",
  },
};

function copyTargets(target: ThreadActionTarget): ThreadActionTarget[] {
  return (target.copies ?? []).map((copy) => ({
    emailAccountId: copy.accountId,
    key: `${copy.accountId}:${copy.threadId}`,
    messageIds: [],
    threadId: copy.threadId,
    rowKey: target.key,
  }));
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

function summarise(verb: string, count: number) {
  return count === 1 ? verb : `${verb} ${count} conversations`;
}

function enqueueFailureCopy(generic: string, rejectionCodes: string[]) {
  if (rejectionCodes[0] === ENGINE_STARTING) {
    return "Mail is still starting. Try again in a moment.";
  }
  return admissionRejectionCopy(rejectionCodes[0]) ?? generic;
}
