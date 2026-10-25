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
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import {
  useCatchUpCopies,
  useCatchUpMailbox,
} from "@/app/(app)/[emailAccountId]/mail/use-catch-up-mailbox";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  actOnCatchUp,
  CATCH_UP_BATCH_SIZE,
  type CatchUpAction,
  type CatchUpItem,
  type CatchUpLive,
  type CatchUpScope,
  type CatchUpSetAside,
  type CatchUpState,
  catchUpConversations,
  catchUpLeft,
  currentCatchUpItem,
  keepCatchUpAccounts,
  reconcileCatchUp,
  revertCatchUp,
  catchUpUnreadConversations,
  setAsideCatchUpAccounts,
  startCatchUp,
  toCatchUpItems,
  toCatchUpLive,
  withCatchUpCopies,
} from "@/app/(app)/[emailAccountId]/mail/catch-up-queue";
import type {
  CardChange,
  ThreadActionOutcome,
  useThreadActions,
} from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
import { useFailedAccountIds } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
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
const NOTHING_SET_ASIDE: Record<string, CatchUpSetAside> = {};
const NO_ACCOUNT_IDS: string[] = [];
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
  "addTargets" | "changeCard" | "subscribeRestored" | "undo"
>;

/**
 * All inboxes, where Catch up walks the Inbox tab of every included account
 * in one order.
 */
type CatchUpAllInboxes = {
  accounts: Array<{ id: string; email: string }>;
  /** Included accounts whose first sync in this browser is still running. */
  waitingAccountIds: string[];
  /** Included accounts the mail engine can't reach. */
  failedAccountIds: string[];
  /**
   * Whether which accounts are syncing or failed is known yet, so neither is
   * counted or walked in the meantime.
   */
  ready: boolean;
};

/**
 * The accounts a view shows together, for Catch up across them. A view that
 * already reads their inboxes from the mail engine passes what it knows of
 * them; otherwise Catch up reads that itself, and only while it's offered.
 */
export type CatchUpAccounts = {
  accounts: CatchUpAllInboxes["accounts"];
  engine?: CatchUpEngineStatus;
};

type CatchUpEngineStatus = {
  /** Included accounts with no finished sync in this browser yet. */
  firstSyncAccountIds: string[];
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
  /**
   * A conversation whose archive or snooze was queued, for a view that hides
   * rows itself. Its copies in the refused accounts were left as they were.
   */
  onRemoved?: (item: CatchUpItem, refusedAccountIds: string[]) => void;
};

type LastAction = {
  item: CatchUpItem;
  action: CatchUpAction;
};

/**
 * Week one's way through a wall of old unread mail: a "Catch up" line that
 * opens an overlay working the oldest unread conversations one at a time.
 * Hidden once the get-started window closes, or when nothing is unread.
 */
export function CatchUpEntry({
  className,
  allInboxes: shownAccounts,
  ...entryProps
}: Omit<CatchUpProps, "allInboxes"> & {
  className?: string;
  allInboxes?: CatchUpAccounts;
}) {
  const { data: user } = useUser();
  const windowOpen = Boolean(user && isGetStartedWindowOpen(user, new Date()));
  const [open, setOpen] = useState(false);
  // Acted on from earlier batches on this page, which the mailbox may not
  // reflect yet when the next batch starts.
  const actedKeys = useRef(new Set<string>());
  const { subscribeRestored } = entryProps.actions;
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
  // In All inboxes a card must reach every copy of its message, which takes
  // an engine that can match a Message-ID; an older desktop build, or an
  // older tab owning the engine, can't, so Catch up isn't offered there.
  const offered =
    !shownAccounts ||
    mailClientSupports(client, "predicate:internet_message_id");
  const allInboxes = useCatchUpAllInboxes(shownAccounts, offered && windowOpen);
  const props: CatchUpProps = { ...entryProps, allInboxes };
  const reading = useCatchUpScope(props, windowOpen);
  const counterQuery = useMemo(
    () => unreadQuery(reading.accountIds, reading.predicate, 1),
    [reading.accountIds, reading.predicate],
  );
  const counted =
    offered &&
    windowOpen &&
    reading.ready &&
    Boolean(client) &&
    reading.accountIds.length > 0;
  const counter = useMailboxWindow(counterQuery, {
    client,
    enabled: counted,
  });
  const view = counted && counter.status === "ready" ? counter.data : null;
  const unread =
    view && !getFirstSyncAccountIds(reading.accountIds, view.coverage).length
      ? view.counts.matchingConversations
      : 0;

  // An open overlay stays while its last conversation leaves the count.
  if (!offered || (!open && unread === 0)) return null;

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
  // Cards left out of this opening's batch, so the read fills past them.
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const reading = useCatchUpScope(props, true);
  const { scope } = reading;
  // Every conversation the batch's cards stand for, copies included, so a
  // card stays while any copy is unread and its copies' accounts are read.
  const watched = useMemo(
    () => (batch ? catchUpConversations(batch) : null),
    [batch],
  );

  const { batch: read, watch } = useCatchUpMailbox({
    client,
    // A batch, once fixed, stays with the accounts it was read from.
    accountIds: watched
      ? [...new Set(watched.map((entry) => entry.accountId))]
      : reading.accountIds,
    tabPredicate: reading.predicate,
    tabReady: reading.ready,
    // In All inboxes a message can come once per account, so enough is read
    // for a full batch once copies are grouped.
    batchRead: Math.min(
      MAX_BATCH_READ,
      (CATCH_UP_BATCH_SIZE + actedKeys.size + leftOut.length) *
        Math.max(1, reading.accountIds.length),
    ),
    watched,
  });
  // The cards before their copies elsewhere are found.
  const candidates = useMemo(
    () =>
      !batch && read.status === "ready"
        ? startCatchUp(
            toCatchUpItems(read.conversations, scope),
            new Set([...actedKeys, ...leftOut]),
          )
        : null,
    [batch, read, scope, actedKeys, leftOut],
  );
  const copies = useCatchUpCopies({
    client,
    accountIds: allInboxes ? reading.accountIds : [],
    cards: candidates ? (allInboxes ? candidates.items : []) : null,
  });
  // The batch is fixed once its cards' copies are known.
  // Cards whose copies couldn't all be found are left out, and the batch is
  // read again past them, until it holds only cards that are safe to act on.
  if (candidates && copies.status === "ready") {
    const filled = withCatchUpCopies(
      candidates,
      copies.found,
      scope,
      actedKeys,
    );
    if (filled.incomplete.length)
      setLeftOut((keys) => [...keys, ...filled.incomplete]);
    else setBatch({ ...filled, incomplete: leftOut });
  }
  if (batch && allInboxes) {
    // An account removed from the view leaves the batch, and one the engine
    // stops reaching mid-batch has its cards set aside, so the other
    // accounts' cards carry on.
    const next = setAsideCatchUpAccounts(
      keepCatchUpAccounts(
        batch,
        allInboxes.accounts.map((account) => account.id),
      ),
      allInboxes.failedAccountIds,
      "unreachable",
    );
    if (next !== batch) setBatch(next);
  }

  // Watches the batch's conversations, so a card read or gone elsewhere is
  // skipped and one with a new message shows it before anything acts on it.
  const live = useMemo<CatchUpLive | null>(
    () =>
      batch && watch
        ? toCatchUpLive(batch, watch.conversations, scope, watch.complete)
        : null,
    [watch, scope, batch],
  );
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
          last && keys.includes(last.item.key) ? null : last,
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
    const change = cardChange(action, snoozeUntil);
    if (!change) return;
    actedKeys.add(key);
    setBatch(actOnCatchUp(fresh, key, action));
    setLastAction({ item, action });

    actions.addTargets([cardTarget(item, Boolean(allInboxes))]);
    let outcome: ThreadActionOutcome = {
      rows: [],
      actedRows: [],
      // Thrown rather than refused: the card's own account is the one known.
      refusedAccountIds: [item.accountId],
    };
    try {
      outcome = await actions.changeCard([key], change);
    } catch {
      // Handled with a refusal, below.
    }
    // Accounts that refused any part have their open cards set aside in All
    // inboxes, so the other accounts' cards carry on.
    const setAside = (state: CatchUpState) =>
      allInboxes && outcome.refusedAccountIds.length
        ? setAsideCatchUpAccounts(state, outcome.refusedAccountIds, "refused")
        : state;
    // Changed in some account: the card stays done, and undoable from here,
    // even when a copy elsewhere refused.
    if (outcome.actedRows.includes(key)) {
      setBatch((state) => state && setAside(state));
      if (via === "key")
        trackMailAction({
          action: TRACKED_ACTIONS[action],
          source: "shortcut",
          shortcut: ACTION_KEYS[action].toLowerCase(),
        });
      if (action !== "keep") onRemoved?.(item, outcome.refusedAccountIds);
      return;
    }
    // Nothing changed (the view's toast says why): the card comes back.
    actedKeys.delete(key);
    setBatch((state) => state && setAside(revertCatchUp(state, key)));
    setLastAction((last) => (last?.item.key === key ? null : last));
  };

  const undo = async () => {
    const last = lastAction;
    if (!last || undoing.current) return;
    undoing.current = true;
    const { key } = last.item;
    try {
      let restored: string[];
      if (last.action === "keep") {
        // Unread again where it was unread before, each in its own account,
        // and nowhere else.
        restored = (
          await actions.changeCard([key], {
            kind: "mark_unread",
            conversations: catchUpUnreadConversations(last.item),
          })
        ).actedRows;
      } else {
        restored = await actions.undo();
      }
      // A failed undo leaves the batch as it was; the view's toast says so.
      // Nothing restored at all means the view had nothing left to undo.
      if (!restored.includes(key)) {
        if (!restored.length)
          setLastAction((now) => (now === last ? null : now));
        return;
      }
      actedKeys.delete(key);
      setBatch((state) => state && revertCatchUp(state, key));
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
          incomplete={batch?.incomplete.length ?? 0}
          setAside={batch?.setAside ?? NOTHING_SET_ASIDE}
          waitingAccountIds={allInboxes.waitingAccountIds}
        />
      ) : null}

      {!batch ? (
        <p
          className="py-10 text-center text-muted-foreground text-sm"
          role="status"
        >
          {read.status === "unavailable" || reading.unreachable
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
                lastAction.item.subject || "(no subject)",
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
  setAside,
  incomplete,
}: {
  accounts: CatchUpAllInboxes["accounts"];
  waitingAccountIds: string[];
  failedAccountIds: string[];
  setAside: Record<string, CatchUpSetAside>;
  incomplete: number;
}) {
  const emailsOf = (ids: string[]) =>
    accounts.filter((account) => ids.includes(account.id)).map((a) => a.email);
  const setAsideFor = (reason: CatchUpSetAside) =>
    Object.keys(setAside).filter((id) => setAside[id] === reason);
  // Each account under the reason its cards were set aside for; one left out
  // from the start counts as unreachable.
  const unreachable = [
    ...new Set([...failedAccountIds, ...setAsideFor("unreachable")]),
  ];
  const failed = emailsOf(unreachable);
  const refused = emailsOf(
    setAsideFor("refused").filter((id) => !unreachable.includes(id)),
  );
  const waiting = emailsOf(
    waitingAccountIds.filter(
      (id) => !unreachable.includes(id) && !setAside[id],
    ),
  );
  if (!failed.length && !waiting.length && !refused.length && !incomplete)
    return null;

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
      {incomplete ? (
        <p className="px-1 text-muted-foreground">
          {incomplete === 1
            ? "1 conversation is left out, as it couldn't be matched safely across your inboxes."
            : `${incomplete} conversations are left out, as they couldn't be matched safely across your inboxes.`}
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
 * included account's inbox the engine has synced and can reach. Until a
 * tab's Cue sorting is known its predicate matches nothing and `ready` is
 * false.
 */
function useCatchUpScope(
  { emailAccountId, query, allInboxes }: CatchUpProps,
  enabled: boolean,
) {
  const { userEmail } = useAccount();
  const usesCue = threadsQueryUsesCue(query);
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
  const scope = useMemo<CatchUpScope>(
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
    predicate: tabPredicate,
    ready: (!usesCue || Boolean(membership)) && (allInboxes?.ready ?? true),
    /** How cards are keyed and named. */
    scope,
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

/**
 * All inboxes' Catch up for the accounts a view shows together: those whose
 * first sync is still running wait, and those the engine can't reach are
 * left out and named. Read from the engine, a row at a time, when the view
 * doesn't already know.
 */
function useCatchUpAllInboxes(
  shown: CatchUpAccounts | undefined,
  enabled: boolean,
): CatchUpAllInboxes | undefined {
  const client = useOptionalMailClient();
  const accounts = shown?.accounts;
  const accountIds = useMemo(
    () => accounts?.map((account) => account.id) ?? [],
    [accounts],
  );
  const reads =
    enabled && Boolean(client) && !shown?.engine && accountIds.length > 0;
  const inboxQuery = useMemo<ConversationQuery>(
    () => ({
      accountIds,
      predicate: { kind: "mailbox", mailbox: "inbox" },
      order: "newest_first",
      pageSize: 1,
      after: null,
    }),
    [accountIds],
  );
  const inbox = useMailboxWindow(inboxQuery, { client, enabled: reads });
  const view = reads && inbox.status === "ready" ? inbox.data : null;
  const firstSyncKey = view
    ? getFirstSyncAccountIds(accountIds, view.coverage).join("\n")
    : "";
  const readFirstSync = useMemo(
    () => (firstSyncKey ? firstSyncKey.split("\n") : NO_ACCOUNT_IDS),
    [firstSyncKey],
  );
  const readFailed = useFailedAccountIds(
    reads ? client : null,
    accountIds,
    view?.connection,
  );
  const firstSyncAccountIds =
    shown?.engine?.firstSyncAccountIds ?? readFirstSync;
  const failedAccountIds =
    shown?.engine?.failedAccountIds ?? readFailed.failedAccountIds;
  // Until the view answers, every account looks synced and reachable.
  const ready = Boolean(shown?.engine) || (Boolean(view) && readFailed.settled);
  return useMemo(
    () =>
      accounts
        ? {
            accounts,
            // An account the engine can't reach is named as failed alone.
            waitingAccountIds: firstSyncAccountIds.filter(
              (accountId) => !failedAccountIds.includes(accountId),
            ),
            failedAccountIds,
            ready,
          }
        : undefined,
    [accounts, failedAccountIds, firstSyncAccountIds, ready],
  );
}

/**
 * The card's conversation as the view's thread actions take it: in All
 * inboxes in its own account, with its copies and where each one is, so an
 * undo puts each back where it was.
 */
function cardTarget(item: CatchUpItem, allInboxes: boolean) {
  return {
    id: item.threadId,
    account: allInboxes ? { id: item.accountId } : undefined,
    messageIds: [item.latestMessageId],
    inInbox: item.inInbox,
    copies: item.copies,
  };
}

/** The change a card action makes; a snooze needs its time picked. */
function cardChange(
  action: CatchUpAction,
  snoozeUntil: Date | undefined,
): CardChange | null {
  if (action === "archive") return { kind: "archive" };
  if (action === "keep") return { kind: "mark_read" };
  return snoozeUntil ? { kind: "snooze", until: snoozeUntil } : null;
}

function doneLine(batch: CatchUpState) {
  const cleared = batch.history.length;
  if (cleared === 1) return "You cleared 1 conversation.";
  if (cleared > 1) return `You cleared ${cleared} conversations.`;
  // Cards set aside or left out are unread mail still waiting, just not now.
  return Object.keys(batch.setAside).length || batch.incomplete.length
    ? "Nothing left to clear for now."
    : "Nothing unread here.";
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
