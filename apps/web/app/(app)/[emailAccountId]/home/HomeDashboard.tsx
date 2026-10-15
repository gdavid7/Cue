"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FocusEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { CheckIcon, FlagIcon } from "lucide-react";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import type { ActionableThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { useThreadActions } from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
import { PlaceholderRow } from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess, undoLatestToast } from "@/components/Toast";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/Typography";
import { useIsLargeScreen } from "@/hooks/use-mobile";
import { useHome } from "@/hooks/useHome";
import { useMailHref } from "@/hooks/useMailHref";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { mailCommandContextAtom } from "@/store/command-palette";
import { markNoReplyNeededAction } from "@/utils/actions/rule-feedback";
import { markNeedsReplyAction } from "@/utils/actions/thread-assist";
import { formatShortDate } from "@/utils/date";
import { getActionErrorMessage } from "@/utils/error";
import type { AgentTask, HomeThread } from "@/utils/home/get-home";
import { prefixPath } from "@/utils/path";
import { AllClear, CueChecked } from "./AllClear";
import { BeforeYourMeeting } from "./BeforeYourMeeting";
import { ConnectLine, NextUpList } from "./NextUp";
import { formatTime } from "./today-format";
import {
  type TodayRowCorrection,
  type TodayRowHandlers,
  TodayThreadRow,
} from "./TodayThreadRow";

const ALSO_IN_INBOX_LIMIT = 5;
const NO_THREADS: ReadonlySet<string> = new Set();
const SKELETON_ROWS = ["w-3/4", "w-2/3", "w-5/6", "w-1/2"];

/**
 * Today answers "what needs me, and what's next?", then gets out of the way.
 * Busy, a summary line and the lanes that have something in them; clear, one
 * "All clear." with proof Cue looked and what's next. Rows act like the
 * inbox's: archive, delete, snooze and reply in place, with the same
 * shortcuts and undo, through the same mail engine commands.
 */
export function HomeDashboard() {
  const { emailAccountId, emailAccount } = useAccount();
  const { data, isLoading, error, mutate } = useHome(emailAccountId);
  const greetingText = useGreeting();
  const firstName = (emailAccount?.name || "").split(" ")[0];
  const mailHref = useMailHref();
  const router = useRouter();
  const isLargeScreen = useIsLargeScreen();
  const engineReady = Boolean(useOptionalMailClient());
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);
  // Rows the user archived, deleted or snoozed. The lanes are a server
  // snapshot, so they're hidden here until an undo brings them back.
  const [hidden, setHidden] = useState(NO_THREADS);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [waitingShown, setWaitingShown] = useState(false);

  const lanes = useMemo(() => {
    if (!data) return null;
    const visible = (threads: HomeThread[]) =>
      threads.filter((thread) => !hidden.has(thread.threadId));
    return {
      needsYou: visible(data.needsYou),
      waiting: visible(data.waiting),
      alsoInInbox: visible(data.alsoInInbox).slice(0, ALSO_IN_INBOX_LIMIT),
    };
  }, [data, hidden]);
  const notice = data ? cueNotice(data.cue, emailAccountId) : null;
  // Nothing needs a reply: who you're waiting on folds into the All clear.
  const allClear = Boolean(lanes && !notice && lanes.needsYou.length === 0);
  // Keyboard order, top to bottom, as the lanes render.
  const rows = useMemo(
    () =>
      lanes
        ? [
            ...lanes.needsYou,
            ...(allClear && !waitingShown ? [] : lanes.waiting),
            ...lanes.alsoInInbox,
          ]
        : [],
    [lanes, allClear, waitingShown],
  );
  const focused = rows.find((thread) => thread.threadId === focusedId);
  const actionable = useMemo<ActionableThread[]>(
    () =>
      data
        ? [...data.needsYou, ...data.waiting, ...data.alsoInInbox].map(
            (thread) => ({
              id: thread.threadId,
              messageIds: [thread.messageId],
            }),
          )
        : [],
    [data],
  );
  const showThreads = useCallback((threadIds: string[]) => {
    setHidden((current) => {
      const next = new Set(current);
      for (const threadId of threadIds) next.delete(threadId);
      return next;
    });
  }, []);
  const {
    archive,
    moveToInbox,
    setReadState,
    setStarredState,
    snooze,
    trash,
    undo,
  } = useThreadActions({
    emailAccountId,
    threads: actionable,
    onRestored: showThreads,
  });

  const threadHref = useCallback(
    (threadId: string, reply = false) =>
      // from=today lets the reader return here rather than to the inbox.
      `${mailHref({ threadId })}?from=today${reply ? "&reply=1" : ""}`,
    [mailHref],
  );

  const focusRow = (threadId: string | null) => {
    setFocusedId(threadId);
    pendingFocus.current = threadId;
  };

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    // With the last row gone, focus stays on Today rather than the body.
    const element = target
      ? [
          ...(rootRef.current?.querySelectorAll<HTMLElement>(
            "[data-today-thread]",
          ) ?? []),
        ]
          .find((row) => row.dataset.todayThread === target)
          ?.querySelector<HTMLElement>('[role="option"]')
      : rootRef.current;
    element?.focus({ preventScroll: !target });
  });

  // Gone at once, with focus on its neighbour; back if the engine refuses it.
  const removeRow = useStableCallback(
    async (
      threadId: string,
      run: (threadKeys: string[]) => Promise<string[]>,
    ) => {
      const index = rows.findIndex((thread) => thread.threadId === threadId);
      const neighbour = rows[index + 1] ?? rows[index - 1];
      setHidden((current) => new Set(current).add(threadId));
      focusRow(neighbour?.threadId ?? null);
      const done = await run([threadId]);
      if (!done.length) showThreads([threadId]);
    },
  );

  // Flags change in place; the server snapshot catches up on its next load.
  const patchRow = useStableCallback(
    async (
      threadId: string,
      change: Partial<HomeThread>,
      undo: Partial<HomeThread>,
      run: (threadKeys: string[]) => Promise<string[]>,
    ) => {
      mutate((current) => current && patchThread(current, threadId, change), {
        revalidate: false,
      });
      const done = await run([threadId]);
      if (!done.length) {
        mutate((current) => current && patchThread(current, threadId, undo), {
          revalidate: false,
        });
      }
    },
  );

  const handlers = useMemo<TodayRowHandlers>(
    () => ({
      archive: (id) => removeRow(id, archive),
      trash: (id) => removeRow(id, trash),
      snooze: (id, until) => removeRow(id, (keys) => snooze(keys, until)),
      moveToInbox: (id) =>
        patchRow(id, { inInbox: true }, { inInbox: false }, moveToInbox),
      setRead: (id, read) =>
        patchRow(id, { unread: !read }, { unread: read }, (keys) =>
          setReadState(keys, read),
        ),
      setStarred: (id, starred) =>
        patchRow(id, { starred }, { starred: !starred }, (keys) =>
          setStarredState(keys, starred),
        ),
      open: (id) => router.push(threadHref(id)),
      reply: (id) => router.push(threadHref(id, true)),
    }),
    [
      archive,
      moveToInbox,
      patchRow,
      removeRow,
      router,
      setReadState,
      setStarredState,
      snooze,
      threadHref,
      trash,
    ],
  );

  const moveFocus = (step: number) => {
    const index = rows.findIndex((thread) => thread.threadId === focusedId);
    const next =
      index === -1
        ? rows[0]
        : rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
    if (next) focusRow(next.threadId);
  };

  // Changes go through the mail engine, which starts with the page; until it
  // has, rows only open and reply.
  const target = engineReady ? focused : undefined;

  // The inbox's triage keys act on the focused row. `h` (snooze) and ⌘K
  // reach it through the command palette, as they do in Mail.
  useShortcuts({
    next: () => moveFocus(1),
    previous: () => moveFocus(-1),
    archive: target?.inInbox
      ? () => handlers.archive(target.threadId)
      : undefined,
    delete: target ? () => handlers.trash(target.threadId) : undefined,
    star: target
      ? () => handlers.setStarred(target.threadId, !target.starred)
      : undefined,
    markRead: target?.unread
      ? () => handlers.setRead(target.threadId, true)
      : undefined,
    markUnread:
      target && !target.unread
        ? () => handlers.setRead(target.threadId, false)
        : undefined,
    reply: focused ? () => handlers.reply(focused.threadId) : undefined,
    undo: async () => {
      if (await undoLatestToast()) return;
      await undo();
    },
  });

  const setMailCommandContext = useSetAtom(mailCommandContextAtom);
  useEffect(() => {
    if (!target) return;
    const id = target.threadId;
    setMailCommandContext({
      actions: {
        archive: () => handlers.archive(id),
        moveToInbox: target.inInbox
          ? undefined
          : () => handlers.moveToInbox(id),
        star: () => handlers.setStarred(id, !target.starred),
        markRead: () => handlers.setRead(id, true),
        markUnread: () => handlers.setRead(id, false),
        snooze: (until) => handlers.snooze(id, until),
        trash: () => handlers.trash(id),
      },
      allStarred: target.starred,
      hasRead: !target.unread,
      hasUnread: target.unread,
      target: { emailAccountId, threadId: id },
      targetCount: 1,
    });
    return () => setMailCommandContext(null);
  }, [emailAccountId, target, handlers, setMailCommandContext]);

  // The row moves lanes at once; the server catches up behind it.
  const correct = async (
    thread: HomeThread,
    needsReply: boolean,
  ): Promise<void> => {
    if (!data) return;
    const moved: GetHomeResponse = needsReply
      ? {
          ...data,
          needsYou: [thread, ...data.needsYou],
          alsoInInbox: data.alsoInInbox.filter(
            (t) => t.threadId !== thread.threadId,
          ),
        }
      : {
          ...data,
          needsYou: data.needsYou.filter((t) => t.threadId !== thread.threadId),
          alsoInInbox: [thread, ...data.alsoInInbox],
        };
    mutate(moved, false);

    const action = needsReply ? markNeedsReplyAction : markNoReplyNeededAction;
    const result = await action(emailAccountId, { threadId: thread.threadId });
    if (result?.serverError || result?.validationErrors) {
      mutate();
      toastError({
        title: "Couldn't update this email",
        description: getActionErrorMessage(
          result,
          "Nothing changed. Check your connection and try again.",
        ),
      });
      return;
    }
    toastSuccess({
      description: needsReply
        ? "Moved to Needs reply."
        : "Removed from Needs reply. Cue will learn from this.",
    });
  };

  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 outline-none md:px-8"
      onFocus={(event: FocusEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (target.getAttribute("role") !== "option") return;
        const id = target
          .closest("[data-today-thread]")
          ?.getAttribute("data-today-thread");
        if (id) setFocusedId(id);
      }}
      ref={rootRef}
      tabIndex={-1}
    >
      <header>
        <PageHeading>
          {greetingText}
          {firstName ? `, ${firstName}` : ""}
        </PageHeading>
        {data && lanes && !notice && !allClear ? (
          <p className="mt-1 text-muted-foreground text-sm" role="status">
            {busySummary(data, lanes.needsYou.length)}
          </p>
        ) : null}
      </header>

      <LoadingContent
        error={error}
        loading={isLoading}
        loadingComponent={
          <HomeSkeleton layout={isLargeScreen ? "list" : "split"} />
        }
      >
        {data && lanes ? (
          <HomeLanes
            data={data}
            lanes={lanes}
            notice={notice}
            allClear={allClear}
            waitingShown={waitingShown}
            onToggleWaiting={() => setWaitingShown((shown) => !shown)}
            emailAccountId={emailAccountId}
            focusedId={focused ? focusedId : null}
            handlers={handlers}
            canChange={engineReady}
            layout={isLargeScreen ? "list" : "split"}
            onCorrect={correct}
            threadHref={threadHref}
          />
        ) : null}
      </LoadingContent>
    </div>
  );
}

function HomeLanes({
  data,
  lanes,
  notice,
  allClear,
  waitingShown,
  onToggleWaiting,
  emailAccountId,
  focusedId,
  handlers,
  canChange,
  layout,
  threadHref,
  onCorrect,
}: {
  data: GetHomeResponse;
  lanes: {
    needsYou: HomeThread[];
    waiting: HomeThread[];
    alsoInInbox: HomeThread[];
  };
  /** Why Cue can't yet say what needs a reply, which then says so instead. */
  notice: ReturnType<typeof cueNotice>;
  allClear: boolean;
  waitingShown: boolean;
  onToggleWaiting: () => void;
  emailAccountId: string;
  focusedId: string | null;
  handlers: TodayRowHandlers;
  /** Whether the mail engine is up to take archive, delete and the rest. */
  canChange: boolean;
  layout: "list" | "split";
  threadHref: (threadId: string) => string;
  onCorrect: (thread: HomeThread, needsReply: boolean) => Promise<void>;
}) {
  const { cue, stats } = data;
  const mailHref = useMailHref();
  const now = new Date();
  const drafts = data.agentTasks.filter((task) => task.kind === "draft");
  const otherTasks = data.agentTasks.filter((task) => task.kind !== "draft");
  const row = (
    thread: HomeThread,
    options: { waiting?: boolean; correction?: TodayRowCorrection } = {},
  ) => (
    <TodayThreadRow
      canChange={canChange}
      correction={options.correction}
      handlers={handlers}
      isFocused={thread.threadId === focusedId}
      key={thread.threadId}
      layout={layout}
      thread={thread}
      waiting={options.waiting}
    />
  );
  const hasFocus = (threads: HomeThread[]) =>
    threads.some((thread) => thread.threadId === focusedId);

  return (
    <>
      {notice ? (
        <div
          className="rounded-lg bg-muted/60 px-4 py-3 text-foreground text-sm"
          role="status"
        >
          {notice.text}
          {notice.link ? (
            <>
              {" "}
              <Link
                className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                href={notice.link.href}
              >
                {notice.link.label}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {allClear ? (
        <AllClear
          data={data}
          emailAccountId={emailAccountId}
          now={now}
          onToggleWaiting={onToggleWaiting}
          waitingOn={
            new Set(lanes.waiting.map((thread) => thread.fromEmail)).size
          }
          waitingShown={waitingShown}
        >
          <ThreadList
            hasFocusedRow={hasFocus(lanes.waiting)}
            label="Waiting on"
          >
            {lanes.waiting.map((thread) => row(thread, { waiting: true }))}
          </ThreadList>
        </AllClear>
      ) : null}
      {/* What needs the user comes first; meeting news sits with what's next. */}
      {allClear ? <BeforeYourMeeting emailAccountId={emailAccountId} /> : null}

      {lanes.needsYou.length > 0 ? (
        <Section
          title="Needs reply"
          count={formatCount(lanes.needsYou.length, stats.needsYouCapped)}
        >
          <ThreadList
            hasFocusedRow={hasFocus(lanes.needsYou)}
            label="Needs reply"
          >
            {lanes.needsYou.map((thread) =>
              row(thread, {
                correction: {
                  label: "No reply needed",
                  icon: CheckIcon,
                  onClick: () => onCorrect(thread, false),
                },
              }),
            )}
          </ThreadList>
        </Section>
      ) : null}

      {drafts.length > 0 || otherTasks.length > 0 ? (
        <Section
          title={drafts.length ? "Drafts ready for you" : "Cue is working on"}
          count={formatCount(data.agentTasks.length, false)}
        >
          <div className="-mx-4 sm:mx-0 border-border/60 border-t">
            {[...drafts, ...otherTasks].map((task) => (
              <TaskRow
                href={threadHref(task.threadId)}
                key={task.id}
                task={task}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {/* The All clear names what's next itself. */}
      {!allClear && (data.nextUp.length > 0 || data.suggestion) ? (
        <Section title="Next up">
          {data.nextUp.length > 0 ? (
            <NextUpList items={data.nextUp} now={now} />
          ) : null}
          {data.suggestion ? (
            <div className={data.nextUp.length > 0 ? "mt-2" : undefined}>
              <ConnectLine
                emailAccountId={emailAccountId}
                name={data.suggestion.name}
                path="/integrations"
                purpose="to see what's due."
              />
            </div>
          ) : null}
        </Section>
      ) : null}
      {allClear ? null : <BeforeYourMeeting emailAccountId={emailAccountId} />}

      {!allClear && lanes.waiting.length > 0 ? (
        <Section
          title="Waiting on"
          count={formatCount(lanes.waiting.length, stats.waitingCapped)}
        >
          <ThreadList
            hasFocusedRow={hasFocus(lanes.waiting)}
            label="Waiting on"
          >
            {lanes.waiting.map((thread) => row(thread, { waiting: true }))}
          </ThreadList>
        </Section>
      ) : null}

      {!allClear && !notice && data.today.checked > 0 ? (
        <p className="text-muted-foreground text-sm">
          <CueChecked today={data.today} />
        </p>
      ) : null}

      {lanes.alsoInInbox.length > 0 ? (
        <Section
          title="Also in your inbox"
          action={
            <Link
              className="font-sans text-muted-foreground text-sm underline-offset-2 hover:text-foreground hover:underline"
              href={mailHref()}
            >
              Open inbox
            </Link>
          }
        >
          <ThreadList
            hasFocusedRow={hasFocus(lanes.alsoInInbox)}
            label="Also in your inbox"
          >
            {lanes.alsoInInbox.map((thread) =>
              row(thread, {
                correction: cue.aiAccess
                  ? {
                      label: "Needs reply",
                      icon: FlagIcon,
                      onClick: () => onCorrect(thread, true),
                    }
                  : undefined,
              }),
            )}
          </ThreadList>
        </Section>
      ) : null}
    </>
  );
}

/** Why Cue can't yet say what needs a reply, or null when it can. */
function cueNotice(
  cue: GetHomeResponse["cue"],
  emailAccountId: string,
): { text: string; link?: { label: string; href: string } } | null {
  if (!cue.aiAccess) {
    return {
      text: "Turn on the AI assistant to see what needs a reply.",
      link: { label: "See plans", href: "/premium" },
    };
  }
  if (!cue.replyTracking) {
    return {
      text: "Reply tracking is off, so Cue isn't checking what needs a reply.",
      link: {
        label: "Turn it on in Rules",
        href: prefixPath(emailAccountId, "/automation"),
      },
    };
  }
  if (!cue.hasReadMail) {
    return {
      text: "Cue is reading your recent mail. What needs a reply will appear here.",
    };
  }
  return null;
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 className="mb-2 flex items-center gap-2 font-title text-foreground text-lg">
        <span id={headingId}>{title}</span>
        {count ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-muted-foreground text-xs">
            {count}
          </span>
        ) : null}
        {action ? <span className="ml-auto">{action}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * A lane of conversations, flat like the inbox and edge to edge on phones.
 * Rows take focus one at a time (j/k or arrows move it), so Tab moves between
 * lanes: a lane without the focused row takes Tab and hands it to its first.
 */
function ThreadList({
  label,
  hasFocusedRow,
  children,
}: {
  label: string;
  hasFocusedRow: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-label={label}
      className="-mx-4 sm:mx-0 border-border/60 border-t outline-none"
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return;
        event.currentTarget
          .querySelector<HTMLElement>('[role="option"]')
          ?.focus();
      }}
      role="listbox"
      tabIndex={hasFocusedRow ? -1 : 0}
    >
      {children}
    </div>
  );
}

function TaskRow({ task, href }: { task: AgentTask; href: string }) {
  return (
    <Link
      className="flex w-full items-center gap-3 border-border/60 border-b bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={href}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground text-sm">
          {task.title}
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {task.detail}
        </div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatShortDate(new Date(task.at))}
      </span>
    </Link>
  );
}

/** A lane's heading and rows, line for line, so nothing jumps when it lands. */
function HomeSkeleton({ layout }: { layout: "list" | "split" }) {
  return (
    <div aria-hidden>
      <div className="mb-2 flex h-7 items-center">
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="-mx-4 sm:mx-0 border-border/60 border-t">
        {SKELETON_ROWS.map((width) => (
          <PlaceholderRow key={width} layout={layout} width={width} />
        ))}
      </div>
    </div>
  );
}

/** "3 need a reply · next: Design review 2:00 PM". */
function busySummary(data: GetHomeResponse, needsReply: number) {
  const count = formatCount(needsReply, data.stats.needsYouCapped) ?? "0";
  const status = `${count} ${needsReply === 1 ? "needs" : "need"} a reply`;
  const next = data.calendar.next;
  if (!next) return status;
  return `${status} · ${next.tomorrow ? "tomorrow" : "next"}: ${next.title} ${formatTime(next.at)}`;
}

/**
 * Time of day comes from the browser's clock, which the server doesn't know,
 * so render a neutral greeting until mounted rather than mismatch on hydration.
 */
function useGreeting() {
  const [text, setText] = useState("Hello");
  useEffect(() => {
    const hour = new Date().getHours();
    setText(
      hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening",
    );
  }, []);
  return text;
}

/** Lists are capped, so a full one reads "10+", and an empty one shows no pill. */
function formatCount(count: number, capped: boolean) {
  if (!count) return;
  return capped ? `${count}+` : String(count);
}

function patchThread(
  data: GetHomeResponse,
  threadId: string,
  change: Partial<HomeThread>,
): GetHomeResponse {
  const patch = (threads: HomeThread[]) =>
    threads.map((thread) =>
      thread.threadId === threadId ? { ...thread, ...change } : thread,
    );
  return {
    ...data,
    needsYou: patch(data.needsYou),
    waiting: patch(data.waiting),
    alsoInInbox: patch(data.alsoInInbox),
  };
}
