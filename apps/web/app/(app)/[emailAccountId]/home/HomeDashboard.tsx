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
import type { KeyedMutator } from "swr";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { CheckIcon, FlagIcon, MailSearchIcon, PauseIcon } from "lucide-react";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { AllInboxesFailedNotice } from "@/app/(app)/[emailAccountId]/mail/AllInboxesFailedNotice";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  type ActionableThread,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { useThreadActions } from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
import { PlaceholderRow } from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess, undoLatestToast } from "@/components/Toast";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/Typography";
import { useIsLargeScreen } from "@/hooks/use-mobile";
import { useHome } from "@/hooks/useHome";
import {
  ALSO_IN_INBOX_LIMIT,
  removeFromCachedToday,
} from "@/utils/home/today-cache";
import { useMailHref } from "@/hooks/useMailHref";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { mailCommandContextAtom } from "@/store/command-palette";
import { markNoReplyNeededAction } from "@/utils/actions/rule-feedback";
import { markNeedsReplyAction } from "@/utils/actions/thread-assist";
import { formatShortDate } from "@/utils/date";
import { getActionErrorMessage } from "@/utils/error";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { registerEngineAccounts } from "@/utils/mail-engine/engine-accounts";
import type { HomeLane, HomeThread } from "@/utils/home/get-home";
import type {
  TodayAccount,
  TodayAgentTask,
  TodayData,
  TodayThread,
} from "@/utils/home/merge-home";
import { AllClear, CueChecked } from "./AllClear";
import {
  type CueNotice,
  CueNoticeStatus,
  replyTrackingOffNotice,
} from "./CueNotice";
import { BeforeYourMeeting } from "./BeforeYourMeeting";
import { ConnectLine, NextUpList } from "./NextUp";
import { formatTime } from "./today-format";
import { GetStartedChecklist } from "./GetStartedChecklist";
import { TodayWeather } from "./TodayWeather";
import {
  type TodayRowCorrection,
  type TodayRowHandlers,
  TodayThreadRow,
} from "./TodayThreadRow";
import { useAllAccountsHome, useTodayAccounts } from "./use-all-accounts-home";

const NO_THREADS: ReadonlySet<string> = new Set();
const NO_LANES: ReadonlySet<HomeLane> = new Set();
const SKELETON_ROWS = ["w-3/4", "w-2/3", "w-5/6", "w-1/2"];

/**
 * Today answers "what needs me, and what's next?", then gets out of the way.
 * Busy, a summary line and the lanes that have something in them; clear, one
 * "All clear." with proof Cue looked and what's next. Rows act like the
 * inbox's: archive, delete, snooze and reply in place, with the same
 * shortcuts and undo, through the same mail engine commands.
 */
export function HomeDashboard() {
  const { emailAccountId, emailAccount, accountIds } = useAccount();
  // Set on Today across accounts, which shows every account in All inboxes
  // as one account's Today shows it.
  const allInboxesAccounts = useTodayAccounts();
  const single = useHome(allInboxesAccounts ? null : emailAccountId);
  const all = useAllAccountsHome(allInboxesAccounts);
  const { merged } = all;
  const data: TodayData | undefined = merged ? merged.data : single.data;
  const isLoading = merged ? merged.isLoading : single.isLoading;
  const error = merged ? merged.error : single.error;
  const gaveUp = merged ? false : single.gaveUp;
  // A refresh that didn't land: what shows is what Today had earlier.
  const refreshFailed = merged
    ? merged.failedAccountIds.length > 0
    : gaveUp || (Boolean(data) && single.error !== undefined);
  // A copy from an earlier day: its conversations show, its day doesn't.
  const earlierDay = Boolean(data?.earlierDay);
  const accountColorIndexById = useMemo(
    () =>
      Object.fromEntries(
        (allInboxesAccounts ?? []).map((account, index) => [account.id, index]),
      ),
    [allInboxesAccounts],
  );
  const greetingText = useGreeting();
  const firstName = (emailAccount?.name || "").split(" ")[0];
  const mailHref = useMailHref();
  const router = useRouter();
  const isLargeScreen = useIsLargeScreen();
  const mailClient = useOptionalMailClient();
  const engineReady = Boolean(mailClient);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);
  // Rows the user archived, deleted or snoozed. The lanes are a server
  // snapshot, so they're hidden here until an undo brings them back.
  const [hidden, setHidden] = useState(NO_THREADS);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [waitingShown, setWaitingShown] = useState(false);

  // The local engine syncs, and so acts in, only accounts it was told about;
  // the routed one is told on startup. All inboxes tells it the same way.
  useEffect(() => {
    if (!mailClient || !allInboxesAccounts) return;
    registerEngineAccounts(
      mailClient,
      allInboxesAccounts
        .filter((account) => account.id !== emailAccountId)
        .map((account) => ({
          accountId: account.id,
          provider: isMicrosoftProvider(account.provider)
            ? "microsoft"
            : "google",
        })),
    ).catch(() => undefined);
  }, [allInboxesAccounts, emailAccountId, mailClient]);

  const lanes = useMemo(() => {
    if (!data) return null;
    const visible = (threads: TodayThread[]) =>
      threads.filter((thread) => !hidden.has(rowKey(thread)));
    return {
      needsYou: visible(data.needsYou),
      waiting: visible(data.waiting),
      alsoInInbox: visible(data.alsoInInbox).slice(0, ALSO_IN_INBOX_LIMIT),
    };
  }, [data, hidden]);
  const notice =
    data && lanes && !earlierDay
      ? cueNotice(data.cue, emailAccountId, {
          hasTrackedThreads:
            lanes.needsYou.length > 0 || lanes.waiting.length > 0,
        })
      : null;
  // Gmail couldn't serve these in time; they load on the next refresh.
  const pending = useMemo(() => new Set(data?.pending), [data]);
  const failed = useMemo(() => new Set(data?.failed), [data]);
  // Whether the Needs reply lane is what Cue knows, rather than empty because
  // it hasn't loaded.
  const needsYouLoaded = !pending.has("needsYou") && !failed.has("needsYou");
  // Nothing needs a reply: who you're waiting on folds into the All clear.
  const allClear = Boolean(
    lanes &&
      !earlierDay &&
      !notice &&
      needsYouLoaded &&
      lanes.needsYou.length === 0,
  );
  // Rows kept from an earlier answer that the last refresh couldn't replace.
  const outdated = useMemo(
    () => (refreshFailed ? new Set(data?.stale) : NO_LANES),
    [data, refreshFailed],
  );
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
  const focused = rows.find((thread) => rowKey(thread) === focusedId);
  const allRows = useMemo(
    () =>
      data ? [...data.needsYou, ...data.waiting, ...data.alsoInInbox] : [],
    [data],
  );
  const actionable = useMemo<ActionableThread[]>(
    () =>
      allRows.map((thread) => ({
        id: thread.threadId,
        // Across accounts each row acts in its own account.
        ...(thread.account ? { account: { id: thread.account.id } } : {}),
        messageIds: [thread.messageId],
      })),
    [allRows],
  );
  const rowByKey = useMemo(
    () => new Map(allRows.map((thread) => [rowKey(thread), thread])),
    [allRows],
  );
  // The row's own account's Today, which its changes are made to.
  const mutateFor = useCallback(
    (thread: TodayThread): KeyedMutator<GetHomeResponse> | undefined =>
      merged
        ? thread.account && all.mutateAccount(thread.account.id)
        : single.mutate,
    [all.mutateAccount, merged, single.mutate],
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
    (thread: { threadId: string; account?: TodayAccount }, reply = false) => {
      // Across accounts a row opens in All inboxes, in its own account, so
      // the reader comes back to Today across accounts.
      const threadAccountIndex = thread.account
        ? accountIds.indexOf(thread.account.id)
        : -1;
      const href =
        threadAccountIndex >= 0
          ? mailHref({
              allInboxes: true,
              threadId: thread.threadId,
              threadAccountIndex,
            })
          : mailHref({ threadId: thread.threadId });
      // from=today lets the reader return here rather than to the inbox.
      return `${href}${href.includes("?") ? "&" : "?"}from=today${reply ? "&reply=1" : ""}`;
    },
    [accountIds, mailHref],
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
    async (key: string, run: (threadKeys: string[]) => Promise<string[]>) => {
      const index = rows.findIndex((thread) => rowKey(thread) === key);
      const neighbour = rows[index + 1] ?? rows[index - 1];
      setHidden((current) => new Set(current).add(key));
      focusRow(neighbour ? rowKey(neighbour) : null);
      const done = await run([key]);
      if (!done.length) return showThreads([key]);
      // So it doesn't come back on the next visit before Today refreshes.
      const thread = rowByKey.get(key);
      if (thread)
        removeFromCachedToday(thread.account?.id ?? emailAccountId, [
          thread.threadId,
        ]);
    },
  );

  // Flags change in place; the server snapshot catches up on its next load.
  const patchRow = useStableCallback(
    async (
      key: string,
      change: Partial<HomeThread>,
      undo: Partial<HomeThread>,
      run: (threadKeys: string[]) => Promise<string[]>,
    ) => {
      const thread = rowByKey.get(key);
      const mutate = thread && mutateFor(thread);
      if (!thread || !mutate) return;
      mutate(
        (current) => current && patchThread(current, thread.threadId, change),
        { revalidate: false },
      );
      const done = await run([key]);
      if (!done.length) {
        mutate(
          (current) => current && patchThread(current, thread.threadId, undo),
          { revalidate: false },
        );
      }
    },
  );
  const openRow = useStableCallback((key: string, reply?: boolean) => {
    const thread = rowByKey.get(key);
    if (thread) router.push(threadHref(thread, reply));
  });

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
      open: (id) => openRow(id),
      reply: (id) => openRow(id, true),
    }),
    [
      archive,
      moveToInbox,
      openRow,
      patchRow,
      removeRow,
      setReadState,
      setStarredState,
      snooze,
      trash,
    ],
  );

  const moveFocus = (step: number) => {
    const index = rows.findIndex((thread) => rowKey(thread) === focusedId);
    const next =
      index === -1
        ? rows[0]
        : rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
    if (next) focusRow(rowKey(next));
  };

  // Changes go through the mail engine, which starts with the page; until it
  // has, rows only open and reply.
  const target = engineReady ? focused : undefined;
  const targetKey = target ? rowKey(target) : undefined;
  const focusedKey = focused ? rowKey(focused) : undefined;

  // The inbox's triage keys act on the focused row. `h` (snooze) and ⌘K
  // reach it through the command palette, as they do in Mail.
  useShortcuts({
    next: () => moveFocus(1),
    previous: () => moveFocus(-1),
    archive:
      target?.inInbox && targetKey
        ? () => handlers.archive(targetKey)
        : undefined,
    delete: targetKey ? () => handlers.trash(targetKey) : undefined,
    star:
      target && targetKey
        ? () => handlers.setStarred(targetKey, !target.starred)
        : undefined,
    markRead:
      target?.unread && targetKey
        ? () => handlers.setRead(targetKey, true)
        : undefined,
    markUnread:
      target && targetKey && !target.unread
        ? () => handlers.setRead(targetKey, false)
        : undefined,
    reply: focusedKey ? () => handlers.reply(focusedKey) : undefined,
    undo: async () => {
      if (await undoLatestToast()) return;
      await undo();
    },
  });

  const setMailCommandContext = useSetAtom(mailCommandContextAtom);
  useEffect(() => {
    if (!target) return;
    const id = rowKey(target);
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
      target: {
        emailAccountId: target.account?.id ?? emailAccountId,
        threadId: target.threadId,
      },
      targetCount: 1,
    });
    return () => setMailCommandContext(null);
  }, [emailAccountId, target, handlers, setMailCommandContext]);

  // The row moves lanes at once; the server catches up behind it.
  const correct = async (
    thread: TodayThread,
    needsReply: boolean,
  ): Promise<void> => {
    const mutate = mutateFor(thread);
    if (!data || !mutate) return;
    const { account, alsoIn: _alsoIn, ...row } = thread;
    mutate((current) => current && moveLane(current, row, needsReply), {
      revalidate: false,
    });

    // Across accounts the row's own account is told, not the page's.
    const action = needsReply ? markNeedsReplyAction : markNoReplyNeededAction;
    const result = await action(account?.id ?? emailAccountId, {
      threadId: thread.threadId,
    });
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <PageHeading>
            {greetingText}
            {firstName ? `, ${firstName}` : ""}
          </PageHeading>
          <TodayWeather />
        </div>
        {earlierDay ? (
          <p className="mt-1 text-muted-foreground text-sm" role="status">
            {refreshFailed
              ? "Couldn't refresh. Showing what Today had earlier."
              : "Updating…"}
          </p>
        ) : data && lanes && !notice && !allClear && needsYouLoaded ? (
          <p className="mt-1 text-muted-foreground text-sm" role="status">
            {busySummary(data, lanes.needsYou.length)}
          </p>
        ) : null}
      </header>

      <GetStartedChecklist />

      <LoadingContent
        hasData={Boolean(data)}
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
            accountIds={allInboxesAccounts?.map((account) => account.id)}
            accountColorIndexById={accountColorIndexById}
            focusedId={focused ? focusedId : null}
            handlers={handlers}
            canChange={engineReady}
            layout={isLargeScreen ? "list" : "split"}
            onCorrect={correct}
            // Past the last refresh a pending lane would load forever.
            pending={gaveUp ? NO_LANES : pending}
            outdated={outdated}
            threadHref={threadHref}
          />
        ) : null}
        {merged ? (
          <div className="overflow-hidden rounded-md">
            <AllInboxesFailedNotice
              accounts={allInboxesAccounts ?? []}
              failedAccountIds={merged.failedAccountIds}
              onRetry={() => all.retryAccounts(merged.failedAccountIds)}
            />
          </div>
        ) : null}
        {!merged && (gaveUp || failed.size > 0) ? (
          <ErrorDisplay
            error={{
              error: gaveUp
                ? "Today's lanes didn't load in time"
                : "Some of Today's lanes didn't load",
            }}
            onRetry={single.retry}
          />
        ) : null}
      </LoadingContent>
      {all.loaders}
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
  accountIds,
  accountColorIndexById,
  focusedId,
  handlers,
  canChange,
  layout,
  threadHref,
  onCorrect,
  pending,
  outdated,
}: {
  data: TodayData;
  lanes: {
    needsYou: TodayThread[];
    waiting: TodayThread[];
    alsoInInbox: TodayThread[];
  };
  /** Why Cue can't yet say what needs a reply, which then says so instead. */
  notice: ReturnType<typeof cueNotice>;
  allClear: boolean;
  waitingShown: boolean;
  onToggleWaiting: () => void;
  emailAccountId: string;
  /** Across accounts: every account Today shows. */
  accountIds?: string[];
  accountColorIndexById: Record<string, number>;
  focusedId: string | null;
  handlers: TodayRowHandlers;
  /** Whether the mail engine is up to take archive, delete and the rest. */
  canChange: boolean;
  layout: "list" | "split";
  threadHref: (thread: { threadId: string; account?: TodayAccount }) => string;
  onCorrect: (thread: TodayThread, needsReply: boolean) => Promise<void>;
  pending: ReadonlySet<HomeLane>;
  /** Lanes showing rows from an earlier answer that a refresh couldn't replace. */
  outdated: ReadonlySet<HomeLane>;
}) {
  const { cue, stats } = data;
  const mailHref = useMailHref();
  const now = new Date();
  const drafts = data.agentTasks.filter((task) => task.kind === "draft");
  const otherTasks = data.agentTasks.filter((task) => task.kind !== "draft");
  const row = (
    thread: TodayThread,
    options: { waiting?: boolean; correction?: TodayRowCorrection } = {},
  ) => (
    <TodayThreadRow
      accountColorClassName={
        thread.account
          ? getAccountColorClassName(
              accountColorIndexById[thread.account.id] ?? 0,
            )
          : undefined
      }
      canChange={canChange}
      correction={options.correction}
      handlers={handlers}
      isFocused={rowKey(thread) === focusedId}
      key={rowKey(thread)}
      layout={layout}
      rowKey={rowKey(thread)}
      thread={thread}
      waiting={options.waiting}
    />
  );
  const hasFocus = (threads: TodayThread[]) =>
    threads.some((thread) => rowKey(thread) === focusedId);

  return (
    <>
      {notice ? <CueNoticeStatus notice={notice} /> : null}

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
      {allClear ? (
        <BeforeYourMeeting
          accountIds={accountIds}
          emailAccountId={emailAccountId}
        />
      ) : null}

      {pending.has("needsYou") ? <HomeSkeleton layout={layout} /> : null}
      {lanes.needsYou.length > 0 ? (
        <Section
          title="Needs reply"
          count={formatCount(lanes.needsYou.length, stats.needsYouCapped)}
          outdated={outdated.has("needsYou")}
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
                href={threadHref(task)}
                key={`${task.account?.id ?? ""}:${task.id}`}
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
            <NextUpList items={data.nextUp} layout={layout} now={now} />
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
      {allClear ? null : (
        <BeforeYourMeeting
          accountIds={accountIds}
          emailAccountId={emailAccountId}
        />
      )}

      {pending.has("waiting") ? <HomeSkeleton layout={layout} /> : null}
      {!allClear && lanes.waiting.length > 0 ? (
        <Section
          title="Waiting on"
          count={formatCount(lanes.waiting.length, stats.waitingCapped)}
          outdated={outdated.has("waiting")}
        >
          <ThreadList
            hasFocusedRow={hasFocus(lanes.waiting)}
            label="Waiting on"
          >
            {lanes.waiting.map((thread) => row(thread, { waiting: true }))}
          </ThreadList>
        </Section>
      ) : null}

      {!allClear && !notice && !data.earlierDay && data.today.checked > 0 ? (
        <p className="text-muted-foreground text-sm">
          <CueChecked today={data.today} />
        </p>
      ) : null}

      {pending.has("alsoInInbox") ? <HomeSkeleton layout={layout} /> : null}
      {lanes.alsoInInbox.length > 0 ? (
        <Section
          title="Also in your inbox"
          outdated={outdated.has("alsoInInbox")}
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
  cue: TodayData["cue"],
  emailAccountId: string,
  { hasTrackedThreads }: { hasTrackedThreads: boolean },
): CueNotice | null {
  if (!cue.aiAccess) {
    // Conversations tracked while the assistant was on still show, so only
    // say they would appear when there are none.
    return {
      icon: PauseIcon,
      tone: "quiet",
      title: hasTrackedThreads
        ? "The AI assistant is off, so this list isn't being updated."
        : "Turn on the AI assistant to see what needs a reply.",
      link: { label: "See plans", href: "/premium" },
    };
  }
  // Across accounts, the notice names the account it is about.
  if (!cue.replyTracking)
    return replyTrackingOffNotice(
      cue.replyTrackingOffAccount?.id ?? emailAccountId,
      cue.replyTrackingOffAccount?.email,
    );
  if (!cue.hasReadMail) {
    return {
      icon: MailSearchIcon,
      tone: "info",
      title: cue.readingAccount
        ? `Cue is reading the recent mail in ${cue.readingAccount.email}.`
        : "Cue is reading your recent mail.",
      detail: "What needs a reply will appear here.",
    };
  }
  return null;
}

function Section({
  title,
  count,
  outdated,
  action,
  children,
}: {
  title: string;
  count?: string;
  /** Its rows are from an earlier answer that a refresh couldn't replace. */
  outdated?: boolean;
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
        {outdated ? (
          <span className="font-sans text-muted-foreground text-xs">
            May be out of date
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

function TaskRow({ task, href }: { task: TodayAgentTask; href: string }) {
  return (
    <Link
      // Text starts where the lanes' rows put it, past their unread-dot slot.
      className="flex w-full items-center gap-3 border-border/60 border-b bg-background py-2.5 pr-3.5 pl-8 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted lg:pr-5"
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
      <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">
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

/**
 * "3 need a reply · next: Design review 2:00 PM". The meeting is left to the
 * Next up list when that shows, rather than said twice.
 */
function busySummary(data: TodayData, needsReply: number) {
  const count = formatCount(needsReply, data.stats.needsYouCapped) ?? "0";
  const status = `${count} ${needsReply === 1 ? "needs" : "need"} a reply`;
  const next = data.calendar.next;
  if (!next || data.nextUp.length > 0) return status;
  return (
    <>
      {status} · {next.tomorrow ? "tomorrow" : "next"}: {next.title}{" "}
      <span className="whitespace-nowrap">{formatTime(next.at)}</span>
    </>
  );
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

/** A row's key for its actions: across accounts it names the account. */
function rowKey(thread: TodayThread) {
  return getListThreadKey({ id: thread.threadId, account: thread.account });
}

/** Moves a conversation between Needs reply and the rest of the inbox. */
function moveLane(
  data: GetHomeResponse,
  thread: HomeThread,
  needsReply: boolean,
): GetHomeResponse {
  const others = (threads: HomeThread[]) =>
    threads.filter((t) => t.threadId !== thread.threadId);
  return needsReply
    ? {
        ...data,
        needsYou: [thread, ...data.needsYou],
        alsoInInbox: others(data.alsoInInbox),
      }
    : {
        ...data,
        needsYou: others(data.needsYou),
        alsoInInbox: [thread, ...data.alsoInInbox],
      };
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
