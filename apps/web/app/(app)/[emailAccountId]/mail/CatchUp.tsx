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
import type { ConversationQuery } from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import {
  actOnCatchUp,
  type CatchUpAction,
  type CatchUpItem,
  type CatchUpState,
  catchUpLeft,
  currentCatchUpItem,
  startCatchUp,
  toCatchUpItems,
  undoCatchUp,
} from "@/app/(app)/[emailAccountId]/mail/catch-up-queue";
import { useThreadActions } from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
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
  isTypingTarget,
  MAIL_SHORTCUTS_OFF_ATTRIBUTE,
} from "@/lib/shortcuts/registry";
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
// A wall of old mail can run to thousands; the oldest of the newest thousand
// is as far back as one batch needs to reach on a local read.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

type CatchUpHandlers = {
  /** Starts the existing reply flow for the conversation, after the overlay closes. */
  onReply: (item: CatchUpItem) => void;
  /** Conversations archived or snoozed, for a view that hides rows itself. */
  onRemoved?: (keys: string[]) => void;
  /** Conversations an undo brought back. */
  onRestored?: (keys: string[]) => void;
};

/**
 * Week one's way through a wall of old unread mail: a "Catch up" line that
 * opens an overlay working the oldest unread conversations one at a time.
 * Hidden once the get-started window closes, or when nothing is unread.
 */
export function CatchUpEntry({
  emailAccountId,
  query,
  className,
  ...handlers
}: CatchUpHandlers & {
  emailAccountId: string;
  /** The inbox tab being shown; the batch is its unread mail. */
  query: ThreadsQuery;
  className?: string;
}) {
  const { data: user } = useUser();
  const windowOpen = Boolean(user && isGetStartedWindowOpen(user, new Date()));
  const [open, setOpen] = useState(false);
  // Acted on from earlier batches on this page, which the mailbox may not
  // reflect yet when the next batch starts.
  const actedKeys = useRef(new Set<string>());
  const conversationQuery = useUnreadQuery({
    emailAccountId,
    query,
    pageSize: 1,
    enabled: windowOpen,
  });
  const client = useOptionalMailClient();
  const counter = useMailboxWindow(conversationQuery ?? EMPTY_QUERY, {
    client,
    enabled: Boolean(conversationQuery && client),
  });
  const view = counter.status === "ready" ? counter.data : null;
  const unread =
    view && !getFirstSyncAccountIds([emailAccountId], view.coverage).length
      ? view.counts.matchingConversations
      : 0;

  // An open overlay stays while its last conversation leaves the count.
  if (!open && (!windowOpen || !conversationQuery || unread === 0)) return null;

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
        actedKeys={actedKeys.current}
        emailAccountId={emailAccountId}
        onOpenChange={setOpen}
        open={open}
        query={query}
        {...handlers}
      />
    </div>
  );
}

function CatchUpDialog({
  open,
  onOpenChange,
  ...props
}: CatchUpHandlers & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailAccountId: string;
  query: ThreadsQuery;
  actedKeys: Set<string>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const replying = useRef(false);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-md gap-0 rounded-lg p-0 outline-none motion-reduce:animate-none"
        // Keys pressed here are the card's, and the list behind stays still.
        {...{ [MAIL_SHORTCUTS_OFF_ATTRIBUTE]: "" }}
        onCloseAutoFocus={(event) => {
          // Reply moves focus to the composer it opens.
          if (replying.current) event.preventDefault();
          replying.current = false;
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        ref={contentRef}
        tabIndex={-1}
      >
        <CatchUpBody
          {...props}
          onReply={(item) => {
            replying.current = true;
            onOpenChange(false);
            props.onReply(item);
          }}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function CatchUpBody({
  emailAccountId,
  query,
  actedKeys,
  onReply,
  onRemoved,
  onRestored,
  onClose,
}: CatchUpHandlers & {
  emailAccountId: string;
  query: ThreadsQuery;
  actedKeys: Set<string>;
  onClose: () => void;
}) {
  const client = useOptionalMailClient();
  const [batch, setBatch] = useState<CatchUpState | null>(null);
  const [lastAction, setLastAction] = useState<{
    key: string;
    action: Exclude<CatchUpAction, "snooze">;
  } | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);

  const conversationQuery = useUnreadQuery({
    emailAccountId,
    query,
    pageSize: PAGE_SIZE,
    enabled: !batch,
  });
  const source = useMailboxWindow(conversationQuery ?? EMPTY_QUERY, {
    client,
    enabled: Boolean(conversationQuery && client && !batch),
  });
  const view = source.status === "ready" ? source.data : null;
  const pagesRead = view ? Math.ceil(view.conversations.length / PAGE_SIZE) : 0;
  const wantsMore = Boolean(view?.nextPage) && pagesRead < MAX_PAGES;
  const { loadMore } = source;
  useEffect(() => {
    if (wantsMore && !source.isLoadingMore) loadMore();
  }, [wantsMore, source.isLoadingMore, loadMore]);

  // The batch is fixed once the whole unread set has been read.
  if (
    !batch &&
    view &&
    !wantsMore &&
    !source.isLoadingMore &&
    !getFirstSyncAccountIds([emailAccountId], view.coverage).length
  ) {
    setBatch(
      startCatchUp(toCatchUpItems(view.conversations), { skip: actedKeys }),
    );
  }

  const actionable = useMemo(
    () =>
      (batch?.items ?? []).map((item) => ({
        id: item.threadId,
        messageIds: [item.latestMessageId ?? item.threadId],
      })),
    [batch],
  );
  const threadActions = useThreadActions({
    emailAccountId,
    threads: actionable,
    onRestored,
  });

  useEffect(() => {
    if (!lastAction) return;
    const timer = setTimeout(() => setLastAction(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [lastAction]);

  const current = batch ? currentCatchUpItem(batch) : null;

  const act = async (action: CatchUpAction, snoozeUntil?: Date) => {
    if (!batch || !current) return;
    const { key } = current;
    // A second key press before the card has moved on acts once.
    if (actedKeys.has(key)) return;
    setBatch(actOnCatchUp(batch, key, action));
    actedKeys.add(key);
    setLastAction(action === "snooze" ? null : { key, action });
    if (action !== "keep") onRemoved?.([key]);

    let done: string[] = [];
    if (action === "archive") done = await threadActions.archive([key]);
    if (action === "keep") done = await threadActions.markRead([key]);
    if (action === "snooze" && snoozeUntil)
      done = await threadActions.snooze([key], snoozeUntil);
    if (done.length) return;
    // The engine refused it, and its toast says why: the card comes back.
    actedKeys.delete(key);
    setBatch((state) =>
      state && state.history.at(-1) === key ? undoCatchUp(state).state : state,
    );
    setLastAction((last) => (last?.key === key ? null : last));
    if (action !== "keep") onRestored?.([key]);
  };

  const undo = async () => {
    if (!batch || !lastAction) return;
    const { state, undone } = undoCatchUp(batch);
    if (!undone || undone.key !== lastAction.key) return;
    setBatch(state);
    setLastAction(null);
    actedKeys.delete(undone.key);
    if (undone.action === "archive") await threadActions.undo();
    if (undone.action === "keep")
      await threadActions.setReadState([undone.key], false, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    const shortcut = CARD_SHORTCUTS[key];
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut.tracked)
      trackMailAction({
        action: shortcut.tracked,
        source: "shortcut",
        shortcut: key,
      });
    if (key === "e") act("archive");
    if (key === "s") act("keep");
    if (key === "h") snoozeTriggerRef.current?.click();
    if (key === "r") onReply(current);
  };

  const left = batch ? catchUpLeft(batch) : 0;

  return (
    <div className="flex flex-col gap-4 p-5 sm:p-6" onKeyDown={onKeyDown}>
      <div className="flex items-baseline gap-3 pr-8">
        <DialogTitle className="font-semibold text-base">Catch up</DialogTitle>
        {batch && current ? (
          <span
            aria-live="polite"
            className="text-muted-foreground text-sm tabular-nums"
          >
            {left} left
          </span>
        ) : null}
      </div>
      <DialogDescription className="sr-only">
        Your oldest unread conversations, one at a time.
      </DialogDescription>

      {!batch ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          Finding your oldest unread mail…
        </p>
      ) : current ? (
        <>
          <article
            aria-label={current.subject || "(no subject)"}
            className="fade-in-0 animate-in rounded-lg border border-border bg-card p-4 duration-150 motion-reduce:animate-none"
            data-catch-up-card={current.threadId}
            key={current.key}
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
          </article>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CardButton
              icon={<ArchiveIcon className="size-4" />}
              keyLabel="E"
              label="Archive"
              onClick={() => act("archive")}
            />
            <CardButton
              icon={<CheckIcon className="size-4" />}
              keyLabel="S"
              label="Keep"
              onClick={() => act("keep")}
            />
            <SnoozeButton
              onSnooze={(until) => act("snooze", until)}
              trigger={
                <CardButton
                  icon={<Clock3Icon className="size-4" />}
                  keyLabel="H"
                  label="Snooze"
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
          <p className="text-sm">
            {batch.history.length === 0
              ? "Nothing unread here."
              : batch.history.length === 1
                ? "You cleared 1 conversation."
                : `You cleared ${batch.history.length} conversations.`}
          </p>
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
            <span>
              {lastAction.action === "archive" ? "Archived" : "Marked as read"}
            </span>
            <Button onClick={undo} size="xs-2" variant="ghost">
              <Undo2Icon className="mr-1.5 size-3.5" />
              Undo
              <Kbd className="ml-2">Z</Kbd>
            </Button>
          </>
        ) : null}
      </div>
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
}) {
  return (
    <Button
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

const CARD_SHORTCUTS: Record<string, { tracked?: string }> = {
  e: { tracked: "archive" },
  s: { tracked: "markRead" },
  h: { tracked: "snooze" },
  r: {},
};

const EMPTY_QUERY: ConversationQuery = {
  accountIds: ["none"],
  predicate: { kind: "all", predicates: [] },
  order: "newest_first",
  pageSize: 1,
  after: null,
};

/** The tab's unread conversations, once Cue's sorting is known if the tab uses it. */
function useUnreadQuery({
  emailAccountId,
  query,
  pageSize,
  enabled,
}: {
  emailAccountId: string;
  query: ThreadsQuery;
  pageSize: number;
  enabled: boolean;
}): ConversationQuery | null {
  const usesCue = threadsQueryUsesCue(query);
  const { membership } = useCueMembership(enabled && usesCue);
  return useMemo(() => {
    if (!enabled || (usesCue && !membership)) return null;
    return {
      accountIds: [emailAccountId],
      predicate: {
        kind: "all",
        predicates: [
          threadsQueryToPredicate(query, membership),
          { kind: "read", value: false },
        ],
      },
      order: "newest_first",
      pageSize,
      after: null,
    };
  }, [enabled, usesCue, membership, emailAccountId, query, pageSize]);
}
