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
import {
  CheckIcon,
  ChevronDownIcon,
  FlagIcon,
  MailSearchIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import type { GetCalendarTodayEventsResponse } from "@/app/api/user/calendar/upcoming-events/route";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { AllInboxesFailedNotice } from "@/app/(app)/[emailAccountId]/mail/AllInboxesFailedNotice";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import { CatchUpEntry } from "@/app/(app)/[emailAccountId]/mail/CatchUp";
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
import { useAccounts } from "@/hooks/useAccounts";
import { reportActivationSignal } from "@/hooks/useActivationSignal";
import { useCalendarTodayEvents } from "@/hooks/useCalendarUpcomingEvents";
import { useHome, useHomeCue, useHomeDeadlines } from "@/hooks/useHome";
import {
  ALSO_IN_INBOX_LIMIT,
  removeFromCachedToday,
} from "@/utils/home/today-cache";
import { useMailHref } from "@/hooks/useMailHref";
import { cn } from "@/utils";
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
import type { ThreadsQuery } from "@/utils/threads/validation";
import {
  type TodayAccount,
  type TodayAgentTask,
  type TodayData,
  type TodayThread,
  mergeNextUp,
  todayConversationKey,
} from "@/utils/home/merge-home";
import { AllClear, CueChecked } from "./AllClear";
import {
  type CueNotice,
  CueNoticeStatus,
  replyTrackingOffNotice,
} from "./CueNotice";
import { BeforeYourMeeting } from "./BeforeYourMeeting";
import { ConnectLine, NextUpList } from "./NextUp";
import { formatSenders, formatTime } from "./today-format";
import { GetStartedChecklist } from "./GetStartedChecklist";
import { NeverReadCard } from "./NeverReadCard";
import { TodayWeather } from "./TodayWeather";
import {
  type TodayRowCorrection,
  type TodayRowHandlers,
  TodayThreadRow,
} from "./TodayThreadRow";
import { useAllAccountsHome, useTodayAccounts } from "./use-all-accounts-home";
import { useLocalInboxRows } from "./use-local-inbox-rows";
import { YourDay } from "./YourDay";
import { useWaitingOnYou } from "./use-waiting-on-you";
import { useNeverReadSenders } from "./use-never-read-senders";

const NO_THREADS: ReadonlySet<string> = new Set();
const INBOX_QUERY: ThreadsQuery = { type: "inbox" };
const NO_LANES: ReadonlySet<HomeLane> = new Set();
const SKELETON_ROWS = ["w-3/4", "w-2/3", "w-5/6", "w-1/2"];
const NO_LABEL_IDS: string[] = [];

/**
 * Today answers "what needs me, and what's next?", then gets out of the way.
 * Busy, a summary line and the lanes that have something in them; clear, one
 * "All clear." with proof Cue looked and what's next. Rows act like the
 * inbox's: archive, delete, snooze and reply in place, with the same
 * shortcuts and undo, through the same mail engine commands.
 */
export function HomeDashboard() {
  const { emailAccountId, accountIds, userEmail } = useAccount();
  const { data: accountsData } = useAccounts();
  // Set on Today across accounts, which shows every account in All inboxes
  // as one account's Today shows it.
  const allInboxesAccounts = useTodayAccounts();
  const single = useHome(allInboxesAccounts ? null : emailAccountId);
  const all = useAllAccountsHome(allInboxesAccounts);
  const { merged } = all;
  // Apps are connected for the user, not a mailbox: one load covers every
  // account Today shows. They append to Next up once they answer.
  const deadlines = useHomeDeadlines(emailAccountId);
  const home: TodayData | undefined = merged ? merged.data : single.data;
  const data = useMemo(
    () =>
      home && deadlines?.length
        ? { ...home, nextUp: mergeNextUp([home.nextUp, deadlines]) }
        : home,
    [home, deadlines],
  );
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
  // Calendars are the person's, so the routed account reads every one,
  // across accounts too.
  const { data: day, error: dayError } = useCalendarTodayEvents(
    emailAccountId || null,
  );
  const dayMeetings = useMemo<DayMeetings>(
    () => ({
      ids: new Set(day?.events.map((event) => `event:${event.id}`)),
      // Without an account there's no request, so nothing to wait for.
      loading: Boolean(emailAccountId) && !day && !dayError,
    }),
    [day, dayError, emailAccountId],
  );
  const greetingText = useGreeting();
  const firstName = getUserFirstName(accountsData?.emailAccounts);
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
  const [readingShown, setReadingShown] = useState(false);

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

  // Until the server's answer has the rest of the inbox, the browser's own
  // copy of it shows instead of placeholders.
  const localAccounts = useMemo<TodayAccount[]>(() => {
    if (allInboxesAccounts)
      return allInboxesAccounts.map(({ id, email }) => ({ id, email }));
    return emailAccountId ? [{ id: emailAccountId, email: userEmail }] : [];
  }, [allInboxesAccounts, emailAccountId, userEmail]);
  const { handledLabelIdsByAccount } = all;
  const singleHandledLabelIds = single.data?.handledLabelIds;
  const handledLabelIds = useMemo(() => {
    if (merged) return handledLabelIdsByAccount;
    if (!singleHandledLabelIds) return;
    return { [emailAccountId]: singleHandledLabelIds };
  }, [merged, handledLabelIdsByAccount, emailAccountId, singleHandledLabelIds]);
  // Before Today's answer, Waiting on you shows from local mail for a mailbox
  // Cue hasn't read, where that answer can only agree: Needs reply is empty
  // and Cue has filed nothing. Across accounts it waits for the answer.
  const earlyCue = useHomeCue(
    emailAccountId,
    !data && !allInboxesAccounts && isLoading,
  );
  const beforeAnswer = !data && earlyCue?.hasReadMail === false;
  const waitingOnYouHandledLabelIds = useMemo(
    () =>
      handledLabelIds ??
      (beforeAnswer ? { [emailAccountId]: NO_LABEL_IDS } : undefined),
    [handledLabelIds, beforeAnswer, emailAccountId],
  );
  const localInbox = useLocalInboxRows({
    accounts: localAccounts,
    named: Boolean(allInboxesAccounts),
    handledLabelIds,
    enabled: !data || data.pending.includes("alsoInInbox"),
  });
  const waitingOnYou = useWaitingOnYou({
    accounts: localAccounts,
    named: Boolean(allInboxesAccounts),
    handledLabelIds: waitingOnYouHandledLabelIds,
    // Only for a mailbox Cue hasn't read yet; after that Needs reply is
    // Cue's answer, and this would second-guess it.
    enabled: !data || (!data.cue.hasReadMail && !data.needsYou.length),
  });
  // Only beside a Needs reply that is known to be empty, and never a
  // conversation Today already lists as waiting on someone else.
  const waitingOnYouShown = useMemo(() => {
    if (!data) return beforeAnswer ? waitingOnYou.threads : [];
    if (data.cue.hasReadMail || data.needsYou.length) return [];
    // One account Cue hasn't read has no Needs reply even while it loads;
    // across accounts, another account's may still bring some.
    if (merged && data.pending.includes("needsYou")) return [];
    const waiting = new Set(data.waiting.map(rowKey));
    return waitingOnYou.threads.filter(
      (thread) => !waiting.has(rowKey(thread)),
    );
  }, [data, beforeAnswer, merged, waitingOnYou.threads]);
  const visibleWaitingOnYou = useMemo(
    () => waitingOnYouShown.filter((thread) => !hidden.has(rowKey(thread))),
    [waitingOnYouShown, hidden],
  );
  // Today opened when this mounted, for how long the group took to show.
  const [openedAtMs] = useState(() => performance.now());
  const reportWaitingOnYouShown = useStableCallback(
    (threads: TodayThread[]) => {
      const counts = new Map<string, number>();
      for (const thread of threads) {
        const accountId = thread.account?.id ?? emailAccountId;
        counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
      }
      const msSinceTodayOpened = Math.round(performance.now() - openedAtMs);
      for (const [accountId, itemCount] of counts)
        reportActivationSignal(accountId, "first_waiting_on_you_item", {
          itemCount,
          msSinceTodayOpened,
        });
    },
  );
  const neverRead = useNeverReadSenders({ accounts: localAccounts });
  const alsoInInbox = useMemo(() => {
    // Each conversation shows once on Today, as in the server's answer, and
    // so does a message that reached two mailboxes.
    const shown = new Set(waitingOnYouShown.map(rowKey));
    if (!localInbox)
      return (data?.alsoInInbox ?? []).filter(
        (thread) => !shown.has(rowKey(thread)),
      );
    for (const thread of data?.needsYou ?? []) shown.add(rowKey(thread));
    const needsYouMessages = new Set(data?.needsYou.map(todayConversationKey));
    return localInbox.filter(
      (thread) =>
        !shown.has(rowKey(thread)) &&
        !needsYouMessages.has(todayConversationKey(thread)),
    );
  }, [data, localInbox, waitingOnYouShown]);
  const visibleAlsoInInbox = useMemo(
    () =>
      alsoInInbox
        .filter((thread) => !hidden.has(rowKey(thread)))
        .slice(0, ALSO_IN_INBOX_LIMIT),
    [alsoInInbox, hidden],
  );
  const lanes = useMemo(() => {
    if (!data) return null;
    const visible = (threads: TodayThread[]) =>
      threads.filter((thread) => !hidden.has(rowKey(thread)));
    return {
      needsYou: visible(data.needsYou),
      waitingOnYou: visibleWaitingOnYou,
      waiting: visible(data.waiting),
      alsoInInbox: visibleAlsoInInbox,
      reading: visible(data.reading),
    };
  }, [data, hidden, visibleWaitingOnYou, visibleAlsoInInbox]);
  const notice =
    data && lanes && !earlierDay
      ? cueNotice(data.cue, emailAccountId, {
          hasTrackedThreads:
            lanes.needsYou.length > 0 || lanes.waiting.length > 0,
        })
      : null;
  // Gmail couldn't serve these in time; they load on the next refresh.
  const pending = useMemo(
    () =>
      new Set(
        data?.pending.filter((lane) => !(lane === "alsoInInbox" && localInbox)),
      ),
    [data, localInbox],
  );
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
  const rows = useMemo(() => {
    if (!lanes) return [...visibleWaitingOnYou, ...visibleAlsoInInbox];
    // The All clear holds who you're waiting on, above Waiting on you.
    const middle = allClear
      ? [...(waitingShown ? lanes.waiting : []), ...lanes.waitingOnYou]
      : [...lanes.waitingOnYou, ...lanes.waiting];
    return [
      ...lanes.needsYou,
      ...middle,
      ...lanes.alsoInInbox,
      ...(readingShown ? lanes.reading : []),
    ];
  }, [
    lanes,
    allClear,
    waitingShown,
    readingShown,
    visibleWaitingOnYou,
    visibleAlsoInInbox,
  ]);
  const focused = rows.find((thread) => rowKey(thread) === focusedId);
  const allRows = useMemo(
    () => [
      ...(data?.needsYou ?? []),
      ...waitingOnYouShown,
      ...(data?.waiting ?? []),
      ...alsoInInbox,
      ...(data?.reading ?? []),
    ],
    [data, waitingOnYouShown, alsoInInbox],
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
  // One undo stack for Today: Catch up acts through these too.
  const threadActions = useThreadActions({
    emailAccountId,
    threads: actionable,
    onRestored: showThreads,
  });
  const {
    archive,
    moveToInbox,
    setReadState,
    setStarredState,
    snooze,
    mute,
    trash,
    undo,
  } = threadActions;

  // Catch up acts in the routed account only, where keys are thread ids, and
  // reports a conversation once its archive or snooze has been queued.
  const hideCaughtUp = useCallback(
    (threadIds: string[]) => {
      setHidden((current) => new Set([...current, ...threadIds]));
      removeFromCachedToday(emailAccountId, threadIds);
    },
    [emailAccountId],
  );

  const threadHref = useCallback(
    (thread: { threadId: string; account?: { id: string } }, reply = false) => {
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

  // Gone at once; back if the engine refuses them.
  const removeRows = useStableCallback(
    async (
      keys: string[],
      run: (threadKeys: string[]) => Promise<string[]>,
    ) => {
      setHidden((current) => {
        const next = new Set(current);
        for (const key of keys) next.add(key);
        return next;
      });
      const done = new Set(await run(keys));
      const refused = keys.filter((key) => !done.has(key));
      if (refused.length) showThreads(refused);
      // So they don't come back on the next visit before Today refreshes.
      const threadIdsByAccount = new Map<string, string[]>();
      for (const key of done) {
        const thread = rowByKey.get(key);
        if (!thread) continue;
        const accountId = thread.account?.id ?? emailAccountId;
        threadIdsByAccount.set(accountId, [
          ...(threadIdsByAccount.get(accountId) ?? []),
          thread.threadId,
        ]);
      }
      for (const [accountId, threadIds] of threadIdsByAccount)
        removeFromCachedToday(accountId, threadIds);
    },
  );
  // With focus on its neighbour, so the keyboard keeps its place.
  const removeRow = useStableCallback(
    (key: string, run: (threadKeys: string[]) => Promise<string[]>) => {
      const index = rows.findIndex((thread) => rowKey(thread) === key);
      const neighbour = rows[index + 1] ?? rows[index - 1];
      focusRow(neighbour ? rowKey(neighbour) : null);
      return removeRows([key], run);
    },
  );
  // The whole Reading bundle at once. Read or archived, a newsletter has
  // left the bundle, so its rows go either way.
  const clearReading = useStableCallback((change: "read" | "archive") => {
    const keys = (lanes?.reading ?? []).map(rowKey);
    if (!keys.length) return;
    if (focusedId && keys.includes(focusedId)) focusRow(null);
    return removeRows(
      keys,
      change === "read"
        ? (threadKeys) => setReadState(threadKeys, true)
        : archive,
    );
  });

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
  // Kept in this browser only; focus moves on as when a row is archived.
  const dismissWaitingOnYou = useStableCallback((thread: TodayThread) => {
    const key = rowKey(thread);
    const index = rows.findIndex((row) => rowKey(row) === key);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    if (focusedId === key) focusRow(neighbour ? rowKey(neighbour) : null);
    waitingOnYou.dismiss(thread);
  });

  const openRow = useStableCallback((key: string, reply?: boolean) => {
    const thread = rowByKey.get(key);
    if (thread) router.push(threadHref(thread, reply));
  });

  const handlers = useMemo<TodayRowHandlers>(
    () => ({
      archive: (id) => removeRow(id, archive),
      trash: (id) => removeRow(id, trash),
      snooze: (id, until) => removeRow(id, (keys) => snooze(keys, until)),
      mute: (id) => removeRow(id, mute),
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
      mute,
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
      account: target.account?.email,
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

  const rowContext: TodayRowContext = {
    accountColorIndexById,
    canChange: engineReady,
    focusedId: focused ? focusedId : null,
    handlers,
    layout: isLargeScreen ? "list" : "split",
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
            {busySummary(data, lanes.needsYou.length, dayMeetings)}
          </p>
        ) : null}
      </header>

      <GetStartedChecklist />

      {allInboxesAccounts ? null : (
        <CatchUpEntry
          actions={threadActions}
          emailAccountId={emailAccountId}
          onRemoved={hideCaughtUp}
          onReply={(item) =>
            router.push(threadHref({ threadId: item.threadId }, true))
          }
          query={INBOX_QUERY}
        />
      )}

      <LoadingContent
        hasData={Boolean(data)}
        error={error}
        loading={isLoading}
        loadingComponent={
          <>
            {/* Where it shows once Today answers, so nothing moves then. */}
            <WaitingOnYouSection
              threads={visibleWaitingOnYou}
              rowContext={rowContext}
              onDismiss={dismissWaitingOnYou}
              onShown={reportWaitingOnYouShown}
            />
            <HomeSkeleton layout={isLargeScreen ? "list" : "split"} />
            {/* Cue's lanes wait for the server; the inbox is already here.
                No Needs reply correction: whether Cue is on isn't known yet. */}
            <AlsoInInboxSection
              threads={visibleAlsoInInbox}
              rowContext={rowContext}
            />
          </>
        }
      >
        {data && lanes ? (
          <HomeLanes
            data={data}
            day={day}
            dayMeetings={dayMeetings}
            lanes={lanes}
            notice={notice}
            allClear={allClear}
            waitingShown={waitingShown}
            onToggleWaiting={() => setWaitingShown((shown) => !shown)}
            readingShown={readingShown}
            onToggleReading={() => setReadingShown((shown) => !shown)}
            onClearReading={clearReading}
            emailAccountId={emailAccountId}
            accountIds={allInboxesAccounts?.map((account) => account.id)}
            accountColorIndexById={accountColorIndexById}
            rowContext={rowContext}
            layout={isLargeScreen ? "list" : "split"}
            onCorrect={correct}
            onDismissWaitingOnYou={dismissWaitingOnYou}
            onWaitingOnYouShown={reportWaitingOnYouShown}
            neverRead={
              <NeverReadCard
                accountColorIndexById={accountColorIndexById}
                accounts={allInboxesAccounts ? localAccounts : undefined}
                onHide={neverRead.hide}
                senders={neverRead.senders}
                sinceMs={neverRead.sinceMs}
              />
            }
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
  day,
  dayMeetings,
  lanes,
  notice,
  allClear,
  waitingShown,
  onToggleWaiting,
  readingShown,
  onToggleReading,
  onClearReading,
  emailAccountId,
  accountIds,
  accountColorIndexById,
  rowContext,
  layout,
  threadHref,
  onCorrect,
  onDismissWaitingOnYou,
  onWaitingOnYouShown,
  neverRead,
  pending,
  outdated,
}: {
  data: TodayData;
  /** Today's meetings, for the Your day strip. */
  day?: GetCalendarTodayEventsResponse;
  /** The strip's meetings, which Next up and the All clear don't repeat. */
  dayMeetings: DayMeetings;
  lanes: {
    needsYou: TodayThread[];
    /** From local mail, while Needs reply has nothing of its own. */
    waitingOnYou: TodayThread[];
    waiting: TodayThread[];
    alsoInInbox: TodayThread[];
    reading: TodayThread[];
  };
  /** Why Cue can't yet say what needs a reply, which then says so instead. */
  notice: ReturnType<typeof cueNotice>;
  allClear: boolean;
  waitingShown: boolean;
  onToggleWaiting: () => void;
  readingShown: boolean;
  onToggleReading: () => void;
  onClearReading: (change: "read" | "archive") => void;
  emailAccountId: string;
  /** Across accounts: every account Today shows. */
  accountIds?: string[];
  accountColorIndexById: Record<string, number>;
  rowContext: TodayRowContext;
  layout: "list" | "split";
  threadHref: (thread: {
    threadId: string;
    account?: { id: string };
  }) => string;
  onCorrect: (thread: TodayThread, needsReply: boolean) => Promise<void>;
  onDismissWaitingOnYou: (thread: TodayThread) => void;
  onWaitingOnYouShown: (threads: TodayThread[]) => void;
  /**
   * The first week's clean-up card. Below what needs a reply or waits on
   * someone, which is the day's work; above the rest of the inbox.
   */
  neverRead: React.ReactNode;
  pending: ReadonlySet<HomeLane>;
  /** Lanes showing rows from an earlier answer that a refresh couldn't replace. */
  outdated: ReadonlySet<HomeLane>;
}) {
  const { cue, stats } = data;
  const now = new Date();
  const drafts = data.agentTasks.filter((task) => task.kind === "draft");
  const otherTasks = data.agentTasks.filter((task) => task.kind !== "draft");
  const row = (
    thread: TodayThread,
    options: {
      waiting?: boolean;
      note?: string;
      correction?: TodayRowCorrection;
    } = {},
  ) => renderTodayRow(thread, rowContext, options);
  const hasFocus = (threads: TodayThread[]) =>
    threads.some((thread) => rowKey(thread) === rowContext.focusedId);
  const nextUp = data.nextUp.filter(
    (item) => item.kind !== "event" || !isOnDay(data, dayMeetings, item),
  );
  const yourDay = day?.events.length ? (
    <Section title="Your day">
      <YourDay
        accountIds={accountIds}
        events={day.events}
        layout={layout}
        more={day.more}
        now={now}
        threadHref={threadHref}
      />
    </Section>
  ) : null;

  return (
    <>
      {/* Above Cue's notice: it shows before Today's answer, which brings
          the notice, and stays put when that answer arrives. */}
      <WaitingOnYouSection
        threads={lanes.waitingOnYou}
        rowContext={rowContext}
        onDismiss={onDismissWaitingOnYou}
        onShown={onWaitingOnYouShown}
      />
      {notice ? <CueNoticeStatus notice={notice} /> : null}

      {allClear ? (
        <AllClear
          data={data}
          emailAccountId={emailAccountId}
          nextShown={!isNextInDay(data, dayMeetings)}
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
      {allClear ? yourDay : null}
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
                accountColorClassName={
                  task.account
                    ? getAccountColorClassName(
                        accountColorIndexById[task.account.id] ?? 0,
                      )
                    : undefined
                }
                href={threadHref(task)}
                key={`${task.account?.id ?? ""}:${task.id}`}
                task={task}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {allClear ? null : yourDay}
      {/* The All clear names what's next itself. */}
      {!allClear && (nextUp.length > 0 || data.suggestion) ? (
        <Section title="Next up">
          {nextUp.length > 0 ? (
            <NextUpList items={nextUp} layout={layout} now={now} />
          ) : null}
          {data.suggestion ? (
            <div className={nextUp.length > 0 ? "mt-2" : undefined}>
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

      {neverRead}

      {pending.has("alsoInInbox") ? <HomeSkeleton layout={layout} /> : null}
      <AlsoInInboxSection
        threads={lanes.alsoInInbox}
        outdated={outdated.has("alsoInInbox")}
        rowContext={rowContext}
        correctionFor={
          cue.aiAccess
            ? (thread) => ({
                label: "Needs reply",
                icon: FlagIcon,
                onClick: () => onCorrect(thread, true),
              })
            : undefined
        }
      />

      <ReadingSection
        threads={lanes.reading}
        capped={stats.readingCapped}
        open={readingShown}
        onToggle={onToggleReading}
        onClear={onClearReading}
        outdated={outdated.has("reading")}
        rowContext={rowContext}
      />
    </>
  );
}

/**
 * Local mail from people the user writes to, while Cue hasn't read the
 * mailbox. Shown means on screen, which `onShown` hears each time it changes.
 */
function WaitingOnYouSection({
  threads,
  rowContext,
  onDismiss,
  onShown,
}: {
  threads: TodayThread[];
  rowContext: TodayRowContext;
  onDismiss: (thread: TodayThread) => void;
  onShown: (threads: TodayThread[]) => void;
}) {
  const detailId = useId();
  useEffect(() => {
    if (threads.length) onShown(threads);
  }, [threads, onShown]);
  if (!threads.length) return null;
  return (
    <Section
      title="Waiting on you"
      detail="From your mail, not checked by AI"
      detailId={detailId}
    >
      <ThreadList
        describedBy={detailId}
        hasFocusedRow={threads.some(
          (thread) => rowKey(thread) === rowContext.focusedId,
        )}
        label="Waiting on you"
      >
        {threads.map((thread) =>
          renderTodayRow(thread, rowContext, {
            note: "May need a reply",
            correction: {
              label: "Dismiss",
              icon: XIcon,
              onClick: () => onDismiss(thread),
            },
          }),
        )}
      </ThreadList>
    </Section>
  );
}

/**
 * Unread newsletters in one calm row that names who they're from, rather than
 * a row each. It opens in place to the list; the whole bundle can be marked
 * read or archived at once.
 */
function ReadingSection({
  threads,
  capped,
  open,
  onToggle,
  onClear,
  outdated,
  rowContext,
}: {
  threads: TodayThread[];
  capped: boolean;
  open: boolean;
  onToggle: () => void;
  onClear: (change: "read" | "archive") => void;
  outdated?: boolean;
  rowContext: TodayRowContext;
}) {
  const listId = useId();
  if (!threads.length) return null;
  const actionClassName =
    "font-sans text-muted-foreground text-sm underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50";
  return (
    <Section
      title="Reading"
      count={formatCount(threads.length, capped)}
      outdated={outdated}
      action={
        // Changes go through the mail engine, as the rows' own do.
        <span className="flex items-center gap-3">
          <button
            className={actionClassName}
            disabled={!rowContext.canChange}
            onClick={() => onClear("read")}
            type="button"
          >
            Mark all read
          </button>
          <button
            className={actionClassName}
            disabled={!rowContext.canChange}
            onClick={() => onClear("archive")}
            type="button"
          >
            Archive all
          </button>
        </span>
      }
    >
      <div className="-mx-4 sm:mx-0 border-border/60 border-t">
        <button
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          // Text starts where the lanes' rows put it, past their unread-dot slot.
          className={cn(
            "flex w-full items-center gap-3 bg-background py-2.5 pr-3.5 pl-8 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted lg:pr-5",
            !open && "border-border/60 border-b",
          )}
          onClick={onToggle}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate text-foreground text-sm">
            From {formatSenders(threads.map((thread) => thread.fromName))}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </div>
      {open ? (
        <div id={listId}>
          <ThreadList
            hasFocusedRow={threads.some(
              (thread) => rowKey(thread) === rowContext.focusedId,
            )}
            label="Reading"
          >
            {/* Every row here is a newsletter; the lane already says so. */}
            {threads.map((thread) =>
              renderTodayRow({ ...thread, tag: undefined }, rowContext),
            )}
          </ThreadList>
        </div>
      ) : null}
    </Section>
  );
}

/** The rest of the inbox, from the server's answer or the browser's own mail. */
function AlsoInInboxSection({
  threads,
  outdated,
  rowContext,
  correctionFor,
}: {
  threads: TodayThread[];
  outdated?: boolean;
  rowContext: TodayRowContext;
  /** Moving a row to Needs reply, once Cue is known to be on. */
  correctionFor?: (thread: TodayThread) => TodayRowCorrection;
}) {
  const mailHref = useMailHref();
  if (!threads.length) return null;
  return (
    <Section
      title="Also in your inbox"
      outdated={outdated}
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
        hasFocusedRow={threads.some(
          (thread) => rowKey(thread) === rowContext.focusedId,
        )}
        label="Also in your inbox"
      >
        {threads.map((thread) =>
          renderTodayRow(thread, rowContext, {
            correction: correctionFor?.(thread),
          }),
        )}
      </ThreadList>
    </Section>
  );
}

type TodayRowContext = {
  accountColorIndexById: Record<string, number>;
  /** Whether the mail engine is up to take archive, delete and the rest. */
  canChange: boolean;
  focusedId: string | null;
  handlers: TodayRowHandlers;
  layout: "list" | "split";
};

function renderTodayRow(
  thread: TodayThread,
  context: TodayRowContext,
  options: {
    waiting?: boolean;
    note?: string;
    correction?: TodayRowCorrection;
  } = {},
) {
  const key = rowKey(thread);
  return (
    <TodayThreadRow
      accountColorClassName={
        thread.account
          ? getAccountColorClassName(
              context.accountColorIndexById[thread.account.id] ?? 0,
            )
          : undefined
      }
      canChange={context.canChange}
      correction={options.correction}
      handlers={context.handlers}
      isFocused={key === context.focusedId}
      key={key}
      layout={context.layout}
      note={options.note}
      rowKey={key}
      thread={thread}
      waiting={options.waiting}
    />
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
  detail,
  detailId,
  count,
  outdated,
  action,
  children,
}: {
  title: string;
  /** A quiet line under the title, such as where its rows come from. */
  detail?: string;
  /** For a list that the detail line describes. */
  detailId?: string;
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
      {detail ? (
        <p className="-mt-1 mb-2 text-muted-foreground text-sm" id={detailId}>
          {detail}
        </p>
      ) : null}
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
  describedBy,
  hasFocusedRow,
  children,
}: {
  label: string;
  describedBy?: string;
  hasFocusedRow: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-describedby={describedBy}
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

function TaskRow({
  task,
  href,
  accountColorClassName,
}: {
  task: TodayAgentTask;
  href: string;
  /** Across accounts: the color of the marker naming the task's account. */
  accountColorClassName?: string;
}) {
  return (
    <Link
      // Text starts where the lanes' rows put it, past their unread-dot slot.
      className="flex w-full items-center gap-3 border-border/60 border-b bg-background py-2.5 pr-3.5 pl-8 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted lg:pr-5"
      href={href}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* Where the inbox row puts it: just before the subject. */}
          {task.account ? (
            <AccountMarker
              account={task.account}
              colorClassName={accountColorClassName}
              inInbox
            />
          ) : null}
          <span className="truncate font-medium text-foreground text-sm">
            {task.title}
          </span>
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
 * Next up list or the Your day strip when either shows, rather than said twice.
 */
function busySummary(
  data: TodayData,
  needsReply: number,
  dayMeetings: DayMeetings,
) {
  const count = formatCount(needsReply, data.stats.needsYouCapped) ?? "0";
  const status = `${count} ${needsReply === 1 ? "needs" : "need"} a reply`;
  const next = data.calendar.next;
  if (!next || data.nextUp.length > 0 || isNextInDay(data, dayMeetings))
    return status;
  return (
    <>
      {status} · {next.tomorrow ? "tomorrow" : "next"}: {next.title}{" "}
      <span className="whitespace-nowrap">{formatTime(next.at)}</span>
    </>
  );
}

/**
 * Today's meetings on the Your day strip, by Next up's own `event:` ids. While
 * the strip loads, which is shortly after Today's own answer, `loading` holds
 * today's meetings back from Next up rather than move them once it lands.
 */
type DayMeetings = { ids: ReadonlySet<string>; loading: boolean };

/** A meeting the Your day strip shows, or is about to. */
function isOnDay(
  data: TodayData,
  day: DayMeetings,
  meeting: { id?: string; at: string },
) {
  if (day.loading)
    return (
      data.calendar.connected &&
      new Date(meeting.at).toDateString() === new Date().toDateString()
    );
  return Boolean(meeting.id && day.ids.has(meeting.id));
}

/** Today's next meeting is on the Your day strip already. */
function isNextInDay(data: TodayData, day: DayMeetings) {
  const next = data.calendar.next;
  return Boolean(
    next &&
      !next.tomorrow &&
      isOnDay(data, day, {
        id: next.id ? `event:${next.id}` : undefined,
        at: next.at,
      }),
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

/**
 * The user's own first name: their profile's, or, without one, the name on
 * their own mailbox. Never another mailbox's display name, which can be a
 * team's or a shared inbox's, and never an address.
 */
function getUserFirstName(
  emailAccounts: GetEmailAccountsResponse["emailAccounts"] | undefined,
) {
  const user = emailAccounts?.[0]?.user;
  if (!user) return "";
  const ownMailbox = emailAccounts.find(
    (account) => account.email.toLowerCase() === user.email.toLowerCase(),
  );
  const name = (user.name || ownMailbox?.name || "").trim();
  if (name.includes("@")) return "";
  return name.split(/\s+/)[0] ?? "";
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
    reading: patch(data.reading),
  };
}
