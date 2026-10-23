"use client";

import { useCallback, useEffect, useRef } from "react";
import { format } from "date-fns";
import chunk from "lodash/chunk";
import groupBy from "lodash/groupBy";
import { toast } from "sonner";
import { toastUndo } from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import { randomUuid } from "@/utils/uuid";
import { muteThreadsAction, unmuteThreadsAction } from "@/utils/actions/mute";
import { forgetMutedThreadIds } from "@/utils/web-notifications/muted-thread-ids";
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
import { beginOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import {
  type MessageFolder,
  moveBackChanges,
  readMessageFolders,
  readStoredMessageFolders,
} from "@/utils/mail-engine/message-folders";
import { mapWithConcurrency } from "@/utils/async";
import type { MetadataChange } from "@inboxzero/mail-core/commands";
import { undoConversationChange } from "@/utils/mail-engine/undo-change";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import {
  observeRumConfirmation,
  recordRumAction,
  recordRumAfterPaint,
} from "@/utils/analytics/rum-actions";

const ENGINE_STARTING = "engine_starting";
const FOLDER_READ_CONCURRENCY = 4;
// Well under the engine's 10,000-target cap for one command.
const MOVE_BACK_TARGETS_PER_COMMAND = 1000;
// The mute actions' own per-call limit.
const MUTE_THREADS_PER_CALL = 1000;

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
  /** Where each message was before a folder move, for its undo. */
  sourceFolders?: MessageFolder[];
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
  /** How undo puts back a command the engine has already sent. */
  restore:
    | {
        kind: "conversations";
        compensation: (snapshot: ThreadSnapshot) => MetadataChange;
      }
    | { kind: "move_back"; movedToFolderId: string };
  wholeConversation: boolean;
  // Resolves once the engine has admitted the command, so an undo pressed
  // while it is still being admitted waits for it instead of getting lost.
  snapshots: Promise<ThreadSnapshot[]>;
  undone: boolean;
  /** Reverses what the action changed beyond the mailbox, such as a mute. */
  undoExtra?: () => Promise<void>;
};

export function useThreadActions({
  emailAccountId,
  readerTarget,
  threads,
  wholeConversation = false,
  onRestored,
}: {
  emailAccountId: string;
  readerTarget?: ThreadActionTarget;
  threads: ActionableThread[];
  /**
   * Set in Sent and Drafts, where triage reaches the user's own copies too,
   * as it always has; elsewhere Outlook's are left in place.
   */
  wholeConversation?: boolean;
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
  // cards, which the list may not have loaded.
  const addTargets = useCallback(
    (extra: ActionableThread[]) =>
      rememberTargets(listTargetsByKey.current, extra, emailAccountId),
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
              wholeConversation,
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
    [client, wholeConversation],
  );

  // A retry or another tab taking over can replace the engine, and an undo
  // (the shortcut, or a toast shown before) must reach the one running now.
  // Batches carry their own accounts, so the last one stays undoable across
  // an account switch.
  const undoBatch = useStableCallback(async (batch: UndoableBatch) => {
    if (batch.undone || !client) return [];
    batch.undone = true;
    if (lastAction.current === batch) lastAction.current = null;
    const extraUndone = batch.undoExtra?.();
    const snapshots = await batch.snapshots;
    await extraUndone;
    if (!snapshots.length) return [];

    const { restore } = batch;
    const results = await Promise.allSettled(
      Object.values(groupBy(snapshots, (snapshot) => snapshot.mutationId)).map(
        async (snapshots) => {
          const { emailAccountId, mutationId } = snapshots[0];
          if (restore.kind === "move_back") {
            const cancelled =
              (
                await client.cancelOperation({
                  accountId: emailAccountId,
                  operationId: mutationId,
                })
              ).status === "cancelled";
            // Never sent, so there is nothing to put back.
            if (!cancelled) {
              // Each message goes back where it was, which may differ within
              // one conversation (a reply in Sent, a message filed elsewhere).
              // Read again now for any message the move took that its own
              // read never saw.
              const current = await mapWithConcurrency(
                snapshots,
                FOLDER_READ_CONCURRENCY,
                (snapshot) =>
                  readStoredMessageFolders(client, {
                    accountId: emailAccountId,
                    conversationId: snapshot.threadId,
                  }).catch(() => []),
              );
              const commands = moveBackChanges(
                snapshots.flatMap((snapshot) => snapshot.sourceFolders ?? []),
                restore.movedToFolderId,
                current.flat(),
              ).flatMap(({ change, messageIds }) =>
                chunk(messageIds, MOVE_BACK_TARGETS_PER_COMMAND).map((ids) => ({
                  change,
                  ids,
                })),
              );
              const admissions = await Promise.allSettled(
                commands.map(({ change, ids }) =>
                  client.submitMetadata({
                    accountId: emailAccountId,
                    commandId: randomUuid(),
                    targets: ids.map((messageId) => ({
                      accountId: emailAccountId,
                      messageId,
                    })),
                    change,
                  }),
                ),
              );
              // Restored only once every place it came from has its mail back.
              const failed = admissions.find(
                (admission) =>
                  admission.status === "rejected" ||
                  admission.value.status === "rejected",
              );
              if (failed) throw new Error("move_back_incomplete");
            }
          } else {
            // A command whose conversations were in different places before
            // it needs a different compensation for each.
            const compensations = Object.values(
              groupBy(snapshots, (snapshot) =>
                JSON.stringify(restore.compensation(snapshot)),
              ),
            ).map((group) => ({
              conversationIds: group.map((snapshot) => snapshot.threadId),
              change: restore.compensation(group[0]),
            }));
            await undoConversationChange({
              client,
              accountId: emailAccountId,
              operationId: mutationId,
              compensations,
              wholeConversation: batch.wholeConversation,
            });
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
    const restored = new Set(restoredKeys);
    // A row comes back whole, so a failed row's hidden copies are retried too.
    const failedSnapshots = snapshots.filter(
      (snapshot) => !restored.has(snapshot.rowKey ?? snapshot.key),
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
    if (failedSnapshots.length) {
      // What didn't come back can be undone again, from the toast or the
      // shortcut, without repeating what did.
      batch.snapshots = Promise.resolve(failedSnapshots);
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
    async ({
      threadKeys,
      payload,
      restore,
      copy,
      prepare,
      undoExtra,
    }: {
      threadKeys: string[];
      payload: ThreadMutationPayload;
      restore: UndoableBatch["restore"];
      copy: { done: (count: number) => string; noun: string };
      /** Reads what undo will need, then queues the change with `enqueue`. */
      prepare?: (
        targets: ThreadActionTarget[],
        enqueue: (
          prepared: ThreadActionTarget[],
        ) => ReturnType<typeof enqueueTargets>,
      ) => ReturnType<typeof enqueueTargets>;
      undoExtra?: UndoableBatch["undoExtra"];
    }) => {
      const targets = resolveTargets(threadKeys);
      const enqueued = prepare
        ? prepare(targets, (prepared) => enqueueTargets(prepared, payload))
        : enqueueTargets(targets, payload);
      // The row leaves on the keypress, before the engine admits the command,
      // so the batch is the one to undo from that moment on.
      const previous = lastAction.current;
      const batch: UndoableBatch = {
        restore,
        wholeConversation,
        snapshots: enqueued.then(
          (result) => result.snapshots,
          () => [],
        ),
        undone: false,
        undoExtra,
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
            enqueueFailureCopy(`Couldn't queue ${copy.noun}`, rejectionCodes),
          );
        }
        return [];
      }

      const failedCount = threadKeys.length - rows.length;
      toastUndo({
        message: copy.done(rows.length),
        shortcut: getShortcutHint("undo"),
        onUndo: () => {
          undoBatch(batch);
        },
      });
      if (failedCount) {
        toast.error(
          enqueueFailureCopy(
            `Couldn't queue ${failedCount} of ${threadKeys.length} for ${copy.noun}`,
            rejectionCodes,
          ),
        );
      }
      return rows;
    },
    [enqueueTargets, resolveTargets, undoBatch, wholeConversation],
  );

  const runUndoableAction = useCallback(
    (
      payload: Extract<ThreadMutationPayload, { kind: UndoableAction }>,
      threadKeys: string[],
    ) => {
      const { compensation, done, noun } = UNDOABLE_COPY[payload.kind];
      return runUndoable({
        threadKeys,
        payload,
        restore: { kind: "conversations", compensation },
        copy: { done: (count) => done(count, payload), noun },
      });
    },
    [runUndoable],
  );

  // Muting archives through the same path, so the row leaves the same way;
  // the mute itself is kept in Cue's database, never in the mailbox.
  const mute = useCallback(
    async (threadKeys: string[]) => {
      const muted = setMuted(resolveTargets(threadKeys), true);
      // A conversation that couldn't be archived isn't left muted unseen.
      const unmuteUnqueued = async (queuedRows: string[]) => {
        const queued = new Set(queuedRows);
        const unqueued = (await muted).filter(
          (target) => !queued.has(target.rowKey ?? target.key),
        );
        if (unqueued.length) await setMuted(unqueued, false);
      };
      let rows: string[];
      try {
        rows = await runUndoable({
          threadKeys,
          payload: { kind: "archive" },
          // Archiving ends a snooze, as snoozing's own undo has to account
          // for: the conversation goes back to where it was.
          restore: {
            kind: "conversations",
            compensation: UNDOABLE_COPY.snooze.compensation,
          },
          copy: { done: (count) => summarise("Muted", count), noun: "muting" },
          undoExtra: async () => {
            const mutedTargets = await muted;
            if (!mutedTargets.length) return;
            const unmuted = await setMuted(mutedTargets, false);
            if (unmuted.length < mutedTargets.length)
              toast.error("Couldn't unmute this conversation");
          },
        });
      } catch (error) {
        await unmuteUnqueued([]);
        throw error;
      }
      await unmuteUnqueued(rows);
      return rows;
    },
    [resolveTargets, runUndoable],
  );

  const moveToFolder = useCallback(
    (threadKeys: string[], folder: { folderId: string; name: string }) => {
      const payload: ThreadMutationPayload = {
        kind: "move_to_folder",
        folderId: folder.folderId,
      };
      return runUndoable({
        threadKeys,
        payload,
        restore: { kind: "move_back", movedToFolderId: folder.folderId },
        copy: {
          done: (count) =>
            count === 1
              ? `Moved to ${folder.name}`
              : `Moved ${count} conversations to ${folder.name}`,
          noun: `moving to ${folder.name}`,
        },
        prepare: async (targets, enqueue) => {
          if (!client) return enqueue(targets);
          // Shown now, while the engine is read for where each message is.
          const change = mutationPayloadToChange(payload);
          const retire = change
            ? Object.entries(
                groupBy(targets, (target) => target.emailAccountId),
              ).map(([accountId, accountTargets]) =>
                beginOptimisticTriage(client, {
                  accountId,
                  conversationIds: accountTargets.map(
                    (target) => target.threadId,
                  ),
                  change,
                }),
              )
            : [];
          try {
            const read = await mapWithConcurrency(
              targets,
              FOLDER_READ_CONCURRENCY,
              (target) =>
                readMessageFolders(client, {
                  accountId: target.emailAccountId,
                  conversationId: target.threadId,
                }).catch(() => null),
            );
            // Mail whose folders can't be read stays put: undo couldn't
            // return it.
            return await enqueue(
              targets.flatMap((target, index) => {
                const sourceFolders = read[index];
                return sourceFolders ? [{ ...target, sourceFolders }] : [];
              }),
            );
          } finally {
            // Queued, the command shows the change itself.
            for (const done of retire) done();
          }
        },
      });
    },
    [client, runUndoable],
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
    (threadKeys: string[], snoozedUntil: Date) =>
      runUndoableAction(
        { kind: "snooze", scheduledFor: snoozedUntil.toISOString() },
        threadKeys,
      ),
    [runUndoableAction],
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
    subscribeRestored,
    archive: useCallback(
      (threadKeys: string[]) =>
        runUndoableAction({ kind: "archive" }, threadKeys),
      [runUndoableAction],
    ),
    moveToInbox: useCallback(
      (threadKeys: string[]) =>
        runUndoableAction({ kind: "unarchive" }, threadKeys),
      [runUndoableAction],
    ),
    trash: useCallback(
      (threadKeys: string[]) =>
        runUndoableAction({ kind: "trash" }, threadKeys),
      [runUndoableAction],
    ),
    moveToFolder,
    mute,
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
    compensation: (snapshot: ThreadSnapshot) => MetadataChange;
    done: (count: number, payload: ThreadMutationPayload) => string;
    noun: string;
  }
> = {
  archive: {
    compensation: () => ({ kind: "unarchive" }),
    done: (count) => summarise("Archived", count),
    noun: "archiving",
  },
  unarchive: {
    compensation: () => ({ kind: "archive" }),
    done: (count) =>
      count === 1 ? "Moved to inbox" : `Moved ${count} conversations to inbox`,
    noun: "moving to inbox",
  },
  trash: {
    compensation: () => ({ kind: "restore_from_trash" }),
    done: (count) => summarise("Deleted", count),
    noun: "deletion",
  },
  // Both end the snooze on the server, so it is put back where it was.
  snooze: {
    compensation: (snapshot) =>
      snapshot.inInbox === false ? { kind: "archive" } : { kind: "unarchive" },
    done: (count, payload) =>
      count === 1 && payload.kind === "snooze"
        ? `Snoozed until ${format(new Date(payload.scheduledFor), "EEE, MMM d 'at' p")}`
        : `Snoozed ${count} conversations`,
    noun: "snoozing",
  },
};

/**
 * Mutes (or unmutes) each conversation in the account that owns it, and every
 * copy of it in the user's other accounts, so the copy's new mail stays out of
 * All inboxes too. Resolves with the targets whose account took the change.
 */
async function setMuted(
  targets: ThreadActionTarget[],
  muted: boolean,
): Promise<ThreadActionTarget[]> {
  const all = targets.flatMap((target) => [target, ...copyTargets(target)]);
  const action = muted ? muteThreadsAction : unmuteThreadsAction;
  const results = await Promise.allSettled(
    Object.entries(groupBy(all, (target) => target.emailAccountId)).flatMap(
      ([accountId, accountTargets]) =>
        chunk(
          [...new Set(accountTargets.map((target) => target.threadId))],
          MUTE_THREADS_PER_CALL,
        ).map(async (threadIds) => {
          const result = await action(accountId, { threadIds });
          forgetMutedThreadIds(accountId);
          if (!result?.data) throw new Error("mute_failed");
          const done = new Set(threadIds);
          return accountTargets.filter((target) => done.has(target.threadId));
        }),
    ),
  );
  const done = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (muted && done.length < all.length) {
    toast.error(
      "Couldn't mute this conversation. New replies will still reach your inbox.",
    );
  }
  return done;
}

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

function rememberTargets(
  targets: Map<string, ThreadActionTarget>,
  threads: ActionableThread[],
  emailAccountId: string,
) {
  for (const thread of threads) {
    const messageIds = [...new Set(getListThreadMessageIds(thread))];
    if (!messageIds.length) continue;
    const key = getListThreadKey(thread);
    const labelled = thread.messages?.filter((message) => message.labelIds);
    targets.set(key, {
      emailAccountId: getListThreadEmailAccountId(thread, emailAccountId),
      inInbox: labelled?.length
        ? labelled.some((message) => message.labelIds?.includes("INBOX"))
        : undefined,
      key,
      messageIds,
      threadId: thread.id,
      copies: thread.copies,
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
