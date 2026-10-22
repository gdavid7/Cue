"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArchiveIcon,
  CheckIcon,
  Clock3Icon,
  ReplyIcon,
  Undo2Icon,
} from "lucide-react";
import type {
  ConversationQuery,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { useCatchUpMailbox } from "@/app/(app)/[emailAccountId]/mail/use-catch-up-mailbox";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  actOnCatchUp,
  CATCH_UP_BATCH_SIZE,
  type CatchUpAction,
  type CatchUpItem,
  type CatchUpLive,
  type CatchUpScope,
  type CatchUpState,
  catchUpLeft,
  currentCatchUpItem,
  reconcileCatchUp,
  revertCatchUp,
  setAsideCatchUpAccounts,
  startCatchUp,
  toCatchUpItem,
  toCatchUpItems,
} from "@/app/(app)/[emailAccountId]/mail/catch-up-queue";
import type { useThreadActions } from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
import { Kbd } from "@/components/Kbd";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCueMembership } from "@/hooks/useCueMembership";
import { useUser } from "@/hooks/useUser";
import {
  ALL_SHORTCUTS_OFF,
  isTypingTarget,
  MAIL_SHORTCUTS_OFF_ATTRIBUTE,
} from "@/lib/shortcuts/registry";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { trackMailAction } from "@/utils/analytics/mail-usage";
import { formatShortDate } from "@/utils/date";
import { isGetStartedWindowOpen } from "@/utils/get-started/checklist";
import { getFirstSyncAccountIds } from "@/utils/mail-engine/coverage";
import {
  threadsQueryToPredicate,
  threadsQueryUsesCue,
} from "@/utils/mail-engine/threads-query";
import type { ThreadsQuery } from "@/utils/threads/validation";

const UNDO_WINDOW_MS = 10_000;
// Past the batch, room for conversations acted on in earlier batches that
// the mailbox may still show.
const MAX_BATCH_READ = 100;

/**
 * The host view's own thread actions, so Catch up shares its undo stack: Z
 * after closing the overlay takes back the overlay's last archive, not an
 * older one of the view's.
 */
type CatchUpActions = Pick<
  ReturnType<typeof useThreadActions>,
  | "addTargets"
  | "archive"
  | "markRead"
  | "setReadState"
  | "snooze"
  | "subscribeRestored"
  | "undo"
>;

/**
 * All inboxes: the included accounts, walked in one order, and the list's
 * own predicate for the tab shown, as its label tabs match each account's
 * labels by name.
 */
export type CatchUpAllInboxes = {
  accounts: Array<{ id: string; email: string }>;
  predicate: MailPredicate;
  /** Included accounts whose first sync in this browser is still running. */
  waitingAccountIds: string[];
  /** Included accounts the mail engine can't reach. */
  failedAccountIds: string[];
};

type CatchUpProps = {
  actions: CatchUpActions;
  /** The routed account: the one walked, or All inboxes' preferred copy. */
  emailAccountId: string;
  /** The inbox tab being shown; the batch is its unread mail. */
  query: ThreadsQuery;
  allInboxes?: CatchUpAllInboxes;
  /** Starts the existing reply flow for the conversation, after the overlay closes. */
  onReply: (item: CatchUpItem) => void;
  /** Conversations whose archive or snooze was queued, for a view that hides rows itself. */
  onRemoved?: (keys: string[]) => void;
};

type LastAction = {
  key: string;
  action: CatchUpAction;
  subject: string;
};

/**
 * Week one's way through a wall of old unread mail: a "Catch up" line that
 * opens an overlay working the oldest unread conversations one at a time.
 * Hidden once the get-started window closes, or when nothing is unread.
 */
export function CatchUpEntry({
  className,
  ...props
}: CatchUpProps & { className?: string }) {
  const { data: user } = useUser();
  const windowOpen = Boolean(user && isGetStartedWindowOpen(user, new Date()));
  const [open, setOpen] = useState(false);
  // Acted on from earlier batches on this page, which the mailbox may not
  // reflect yet when the next batch starts.
  const actedKeys = useRef(new Set<string>());
  const { subscribeRestored } = props.actions;
  // A restored conversation is unread in the tab again, so a later batch
  // may offer it.
  useEffect(
    () =>
      subscribeRestored((keys) => {
        for (const key of keys) actedKeys.current.delete(key);
      }),
    [subscribeRestored],
  );
  const client = useOptionalMailClient();
  const scope = useCatchUpScope(props, windowOpen);
  const counterQuery = useMemo(
    () => unreadQuery(scope.accountIds, scope.predicate, 1),
    [scope.accountIds, scope.predicate],
  );
  const counted =
    windowOpen && scope.ready && Boolean(client) && scope.accountIds.length > 0;
  const counter = useMailboxWindow(counterQuery, {
    client,
    enabled: counted,
  });
  const view = counted && counter.status === "ready" ? counter.data : null;
  const unread =
    view && !getFirstSyncAccountIds(scope.accountIds, view.coverage).length
      ? view.counts.matchingConversations
      : 0;

  // An open overlay stays while its last conversation leaves the count.
  if (!open && unread === 0) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm",
        className,
      )}
      data-catch-up-entry=""
    >
      <p className="min-w-0 flex-1 text-muted-foreground">
        {unread === 1
          ? "1 unread conversation waiting"
          : `${unread.toLocaleString()} unread conversations waiting`}
      </p>
      <Button onClick={() => setOpen(true)} size="xs-2" variant="outline">
        Catch up
      </Button>
      <CatchUpDialog
        {...props}
        actedKeys={actedKeys.current}
        onOpenChange={setOpen}
        open={open}
      />
    </div>
  );
}

function CatchUpDialog({
  open,
  onOpenChange,
  ...props
}: CatchUpProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actedKeys: Set<string>;
}) {
  const replying = useRef(false);

  // The body mounts per opening, so each one starts a fresh batch.
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open ? (
        <CatchUpBody
          {...props}
          onClose={() => onOpenChange(false)}
          onCloseAutoFocus={(event) => {
            // Reply moves focus to the composer it opens.
            if (replying.current) event.preventDefault();
            replying.current = false;
          }}
          onReply={(item) => {
            replying.current = true;
            onOpenChange(false);
            props.onReply(item);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function CatchUpBody({
  actedKeys,
  onClose,
  onCloseAutoFocus,
  ...props
}: CatchUpProps & {
  actedKeys: Set<string>;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { actions, allInboxes, onReply, onRemoved } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);
  // Whether the open snooze picker came from H, for the checklist's count.
  const snoozeFromKey = useRef(false);
  const undoing = useRef(false);
  const client = useOptionalMailClient();
  const [batch, setBatch] = useState<CatchUpState | null>(null);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const scope = useCatchUpScope(props, true);

  const { batch: read, watch } = useCatchUpMailbox({
    client,
    // A batch, once fixed, stays with the accounts it was read from.
    accountIds: batch ? batchAccountIds(batch) : scope.accountIds,
    tabPredicate: scope.predicate,
    tabReady: scope.ready,
    batchRead: Math.min(MAX_BATCH_READ, CATCH_UP_BATCH_SIZE + actedKeys.size),
    watched: batch
      ? batch.items.map(({ accountId, threadId }) => ({ accountId, threadId }))
      : null,
  });
  // The batch is fixed from the first full answer for the tab.
  if (!batch && read.status === "ready") {
    setBatch(
      startCatchUp(toCatchUpItems(read.conversations, scope.items), actedKeys),
    );
  }
  // An account the engine stops reaching mid-batch has its cards set aside,
  // so the other accounts' cards carry on.
  if (batch && allInboxes) {
    const setAside = setAsideCatchUpAccounts(
      batch,
      allInboxes.failedAccountIds,
    );
    if (setAside !== batch) setBatch(setAside);
  }

  // Watches the batch's conversations, so a card read or gone elsewhere is
  // skipped and one with a new message shows it before anything acts on it.
  const live = useMemo<CatchUpLive | null>(() => {
    if (!watch) return null;
    const items = new Map<string, CatchUpItem>();
    for (const conversation of watch.conversations) {
      const item = toCatchUpItem(conversation, scope.items);
      if (item) items.set(item.key, item);
    }
    return { items, complete: watch.complete };
  }, [watch, scope.items]);
  if (batch) {
    const reconciled = reconcileCatchUp(batch, live);
    if (reconciled !== batch) setBatch(reconciled);
  }

  // An undo from anywhere in the view (the toast, or Z after closing) brings
  // the card back too.
  const { subscribeRestored } = actions;
  useEffect(
    () =>
      subscribeRestored((keys) => {
        setBatch(
          (state) =>
            state &&
            keys.reduce((next, key) => revertCatchUp(next, key), state),
        );
        setLastAction((last) =>
          last && keys.includes(last.key) ? null : last,
        );
      }),
    [subscribeRestored],
  );

  useEffect(() => {
    if (!lastAction) return;
    const timer = setTimeout(() => setLastAction(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [lastAction]);

  const current = batch ? currentCatchUpItem(batch) : null;

  const act = async (
    action: CatchUpAction,
    via: "key" | "click",
    snoozeUntil?: Date,
  ) => {
    if (!batch) return;
    // Checked again at the moment of acting, in case the mailbox moved since
    // this card was drawn: a changed card is shown rather than acted on.
    const fresh = reconcileCatchUp(batch, live);
    const item = currentCatchUpItem(fresh);
    if (fresh !== batch) setBatch(fresh);
    if (!item || item !== currentCatchUpItem(batch)) return;
    const { key } = item;
    // A second key press before the card has moved on acts once.
    if (actedKeys.has(key)) return;
    actedKeys.add(key);
    setBatch(actOnCatchUp(fresh, key, action));
    setLastAction({ key, action, subject: item.subject });

    // In All inboxes the target names its account, so the command goes to
    // that account's mail, and its copies in other accounts go with it.
    actions.addTargets([
      {
        id: item.threadId,
        account: allInboxes ? { id: item.accountId } : undefined,
        messageIds: [item.latestMessageId],
        copies: item.copies,
      },
    ]);
    let done: string[] = [];
    try {
      if (action === "archive") done = await actions.archive([key]);
      if (action === "keep") done = await actions.markRead([key]);
      if (action === "snooze" && snoozeUntil)
        done = await actions.snooze([key], snoozeUntil);
    } catch {
      // Thrown rather than refused: handled the same way, below.
    }
    if (done.includes(key)) {
      if (via === "key")
        trackMailAction({
          action: TRACKED_ACTIONS[action],
          source: "shortcut",
          shortcut: ACTION_KEYS[action].toLowerCase(),
        });
      if (action !== "keep") onRemoved?.([key]);
      return;
    }
    // The engine refused it (its toast says why), or it threw: the card
    // comes back. In All inboxes its account's cards are set aside instead,
    // so the other accounts' cards carry on.
    actedKeys.delete(key);
    setBatch((state) => {
      if (!state) return state;
      const reverted = revertCatchUp(state, key);
      return allInboxes
        ? setAsideCatchUpAccounts(reverted, [item.accountId])
        : reverted;
    });
    setLastAction((last) => (last?.key === key ? null : last));
  };

  const undo = async () => {
    const last = lastAction;
    if (!last || undoing.current) return;
    undoing.current = true;
    try {
      const restored =
        last.action === "keep"
          ? await actions.setReadState([last.key], false, false)
          : await actions.undo();
      // A failed undo leaves the batch as it was; the view's toast says so.
      // Nothing restored at all means the view had nothing left to undo.
      if (!restored.includes(last.key)) {
        if (!restored.length)
          setLastAction((now) => (now === last ? null : now));
        return;
      }
      actedKeys.delete(last.key);
      setBatch((state) => state && revertCatchUp(state, last.key));
      setLastAction((now) => (now === last ? null : now));
    } finally {
      undoing.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The snooze picker is portaled, and its keys are its own.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && lastAction) {
      event.preventDefault();
      undo();
      return;
    }
    if (!current) return;
    if (key === "e") act("archive", "key");
    else if (key === "s") act("keep", "key");
    else if (key === "h") {
      snoozeFromKey.current = true;
      snoozeTriggerRef.current?.click();
    } else if (key === "r") onReply(current);
    else return;
    event.preventDefault();
  };

  const left = batch ? catchUpLeft(batch) : 0;

  return (
    <DialogContent
      className="flex w-[calc(100%-2rem)] max-w-md flex-col gap-4 rounded-lg p-5 outline-none motion-reduce:animate-none sm:p-6"
      // Keys pressed here are the card's: neither the list behind nor global
      // shortcuts such as `c` and ⌘K run.
      {...{ [MAIL_SHORTCUTS_OFF_ATTRIBUTE]: ALL_SHORTCUTS_OFF }}
      onCloseAutoFocus={onCloseAutoFocus}
      onKeyDown={onKeyDown}
      onOpenAutoFocus={(event) => {
        // Focus rests on the overlay, so its keys work before any button
        // looks pressed.
        event.preventDefault();
        contentRef.current?.focus();
      }}
      ref={contentRef}
      tabIndex={-1}
    >
      <div className="flex items-baseline gap-3 pr-8">
        <DialogTitle className="font-semibold text-base">Catch up</DialogTitle>
        {current ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {left} left
          </span>
        ) : null}
      </div>
      <DialogDescription className="sr-only">
        Your oldest unread conversations, one at a time.
      </DialogDescription>
      <p aria-live="polite" className="sr-only">
        {current
          ? `From ${current.sender}: ${current.subject || "(no subject)"}`
          : ""}
      </p>

      {allInboxes ? (
        <AccountNotes
          accounts={allInboxes.accounts}
          failedAccountIds={allInboxes.failedAccountIds}
          setAsideAccountIds={batch ? Object.keys(batch.setAside) : []}
          waitingAccountIds={allInboxes.waitingAccountIds}
        />
      ) : null}

      {!batch ? (
        <p
          className="py-10 text-center text-muted-foreground text-sm"
          role="status"
        >
          {read.status === "unavailable" || scope.unreachable
            ? "Catch up can't read your mail right now. Try again in a moment."
            : "Finding your oldest unread mail…"}
        </p>
      ) : current ? (
        <>
          <article
            aria-label={current.subject || "(no subject)"}
            className="fade-in-0 animate-in rounded-lg border border-border bg-card p-4 duration-150 motion-reduce:animate-none"
            data-catch-up-card={current.threadId}
            data-catch-up-message={current.latestMessageId}
            key={`${current.key}:${current.latestMessageId}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate font-medium text-sm">
                {current.sender}
              </p>
              <time
                className="shrink-0 text-muted-foreground text-xs"
                dateTime={new Date(current.atMs).toISOString()}
              >
                {formatShortDate(new Date(current.atMs), {
                  includeYear: true,
                })}
              </time>
            </div>
            <h3 className="mt-1 font-semibold text-[15px] leading-snug tracking-tight">
              {current.subject || "(no subject)"}
            </h3>
            <p className="mt-2 line-clamp-3 text-muted-foreground text-sm leading-relaxed">
              {current.preview}
            </p>
            {allInboxes ? (
              <CardAccount
                accountId={current.accountId}
                accounts={allInboxes.accounts}
              />
            ) : null}
          </article>

          <div className="grid grid-cols-2 gap-2">
            <CardButton
              icon={<ArchiveIcon className="size-4" />}
              keyLabel={ACTION_KEYS.archive}
              label="Archive"
              onClick={() => act("archive", "click")}
            />
            <CardButton
              icon={<CheckIcon className="size-4" />}
              keyLabel={ACTION_KEYS.keep}
              label="Keep"
              onClick={() => act("keep", "click")}
            />
            <SnoozeButton
              onSnooze={(until) => {
                const via = snoozeFromKey.current ? "key" : "click";
                snoozeFromKey.current = false;
                act("snooze", via, until);
              }}
              trigger={
                <CardButton
                  icon={<Clock3Icon className="size-4" />}
                  keyLabel={ACTION_KEYS.snooze}
                  label="Snooze"
                  // A pointer opening the picker isn't the keyboard.
                  onPointerDown={() => {
                    snoozeFromKey.current = false;
                  }}
                  ref={snoozeTriggerRef}
                />
              }
            />
            <CardButton
              icon={<ReplyIcon className="size-4" />}
              keyLabel="R"
              label="Reply"
              onClick={() => onReply(current)}
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <p className="text-sm">{doneLine(batch)}</p>
          <Button autoFocus onClick={onClose} variant="outline">
            Done
          </Button>
        </div>
      )}

      <div
        aria-live="polite"
        className="flex min-h-8 items-center justify-between gap-3 text-muted-foreground text-sm"
      >
        {lastAction ? (
          <>
            <span className="min-w-0 truncate">
              {UNDO_LINE[lastAction.action](
                lastAction.subject || "(no subject)",
              )}
            </span>
            <Button
              aria-keyshortcuts="Z"
              className="shrink-0"
              onClick={undo}
              size="xs-2"
              variant="ghost"
            >
              <Undo2Icon className="mr-1.5 size-3.5" />
              Undo
              <Kbd className="ml-2">Z</Kbd>
            </Button>
          </>
        ) : null}
      </div>
    </DialogContent>
  );
}

/** Which inbox the card is in, as All inboxes' rows mark it. */
function CardAccount({
  accountId,
  accounts,
}: {
  accountId: string;
  accounts: CatchUpAllInboxes["accounts"];
}) {
  const index = accounts.findIndex((account) => account.id === accountId);
  const email = accounts[index]?.email;
  if (!email) return null;
  return (
    <p
      className="mt-3 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
      data-catch-up-account={accountId}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          getAccountColorClassName(index),
        )}
      />
      <span className="truncate">{email}</span>
    </p>
  );
}

/**
 * Names the included inboxes Catch up is leaving out and why, so a missing
 * account reads as a state rather than as mail that isn't there.
 */
function AccountNotes({
  accounts,
  waitingAccountIds,
  failedAccountIds,
  setAsideAccountIds,
}: {
  accounts: CatchUpAllInboxes["accounts"];
  waitingAccountIds: string[];
  failedAccountIds: string[];
  setAsideAccountIds: string[];
}) {
  const emailsOf = (ids: string[]) =>
    accounts.filter((account) => ids.includes(account.id)).map((a) => a.email);
  const failed = emailsOf(failedAccountIds);
  const waiting = emailsOf(
    waitingAccountIds.filter((id) => !failedAccountIds.includes(id)),
  );
  const refused = emailsOf(
    setAsideAccountIds.filter((id) => !failedAccountIds.includes(id)),
  );
  if (!failed.length && !waiting.length && !refused.length) return null;

  return (
    <div className="flex flex-col gap-1.5 text-xs" role="status">
      {failed.length ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {failed.join(", ")} couldn&apos;t be loaded, so{" "}
          {failed.length === 1 ? "its" : "their"} mail isn&apos;t in Catch up.
        </p>
      ) : null}
      {refused.length ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Couldn&apos;t update {refused.join(", ")}, so{" "}
          {refused.length === 1 ? "its" : "their"} conversations are set aside
          for now.
        </p>
      ) : null}
      {waiting.length ? (
        <p className="px-1 text-muted-foreground">
          Mail from {waiting.join(", ")} is still loading, so it isn&apos;t in
          Catch up yet.
        </p>
      ) : null}
    </div>
  );
}

function CardButton({
  icon,
  label,
  keyLabel,
  ref,
  ...props
}: {
  icon: ReactNode;
  label: string;
  keyLabel: string;
  ref?: Ref<HTMLButtonElement>;
  onClick?: () => void;
  onPointerDown?: () => void;
}) {
  return (
    <Button
      aria-keyshortcuts={keyLabel}
      className="h-12 justify-between gap-2 px-3 active:scale-[0.97] motion-reduce:active:scale-100"
      ref={ref}
      type="button"
      variant="outline"
      {...props}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <Kbd>{keyLabel}</Kbd>
    </Button>
  );
}

const UNDO_LINE: Record<CatchUpAction, (subject: string) => string> = {
  archive: (subject) => `Archived “${subject}”`,
  keep: (subject) => `Marked “${subject}” as read`,
  snooze: (subject) => `Snoozed “${subject}”`,
};

const ACTION_KEYS: Record<CatchUpAction, string> = {
  archive: "E",
  keep: "S",
  snooze: "H",
};

// What the checklist and analytics hear; Keep is told apart from the list's
// `s`, which stars.
const TRACKED_ACTIONS: Record<CatchUpAction, string> = {
  archive: "archive",
  keep: "catchUpKeep",
  snooze: "snooze",
};

/**
 * What Catch up reads: the routed account's tab, or in All inboxes each
 * included account the engine has synced and can reach, by the list's own
 * predicate. Until a tab's Cue sorting is known its predicate matches
 * nothing and `ready` is false.
 */
function useCatchUpScope(
  { emailAccountId, query, allInboxes }: CatchUpProps,
  enabled: boolean,
) {
  const { userEmail } = useAccount();
  const usesCue = !allInboxes && threadsQueryUsesCue(query);
  const { membership } = useCueMembership(enabled && usesCue);
  const tabPredicate = useMemo(
    () => threadsQueryToPredicate(query, membership),
    [query, membership],
  );
  const accountKey = allInboxes
    ? allInboxes.accounts
        .filter(
          (account) =>
            !allInboxes.waitingAccountIds.includes(account.id) &&
            !allInboxes.failedAccountIds.includes(account.id),
        )
        .map((account) => account.id)
        .join("\n")
    : emailAccountId;
  const accountIds = useMemo(
    () => (accountKey ? accountKey.split("\n") : []),
    [accountKey],
  );
  const accounts = allInboxes?.accounts;
  const items = useMemo<CatchUpScope>(
    () => ({
      ownEmail: (accountId) =>
        accounts?.find((account) => account.id === accountId)?.email ??
        userEmail,
      combined: accounts ? { routedAccountId: emailAccountId } : null,
    }),
    [accounts, emailAccountId, userEmail],
  );
  return {
    accountIds,
    predicate: allInboxes?.predicate ?? tabPredicate,
    ready: !usesCue || Boolean(membership),
    items,
    /** Every included account failed, rather than any still loading. */
    unreachable: Boolean(
      allInboxes &&
        !accountIds.length &&
        allInboxes.accounts.every((account) =>
          allInboxes.failedAccountIds.includes(account.id),
        ),
    ),
  };
}

function doneLine(batch: CatchUpState) {
  const cleared = batch.history.length;
  if (cleared === 1) return "You cleared 1 conversation.";
  if (cleared > 1) return `You cleared ${cleared} conversations.`;
  // Cards set aside are unread mail still waiting, just not now.
  return Object.keys(batch.setAside).length
    ? "Nothing left to clear for now."
    : "Nothing unread here.";
}

/** The accounts a fixed batch was read from. */
function batchAccountIds(batch: CatchUpState) {
  return [...new Set(batch.items.map((item) => item.accountId))];
}

function unreadQuery(
  accountIds: string[],
  tabPredicate: MailPredicate,
  pageSize: number,
): ConversationQuery {
  return {
    accountIds,
    predicate: {
      kind: "all",
      predicates: [tabPredicate, { kind: "read", value: false }],
    },
    order: "newest_first",
    pageSize,
    after: null,
  };
}
