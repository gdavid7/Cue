"use client";

import type { ListThread } from "./types";

import { MailPanelErrorBoundary } from "@/app/(app)/[emailAccountId]/mail/MailPanelErrorBoundary";
import { isThreadStarred } from "@/app/(app)/[emailAccountId]/mail/star-state";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListToolbar } from "@/app/(app)/[emailAccountId]/mail/ListToolbar";
import { getMailSearchFolders } from "@/app/(app)/[emailAccountId]/mail/outlook-folder-list";
import { MailAccountSwitcher } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import { MailMobileNav } from "@/app/(app)/[emailAccountId]/mail/MailMobileNav";
import {
  getMailboxName,
  MAIL_SCHEDULED_TYPE,
  MAIL_SNOOZED_TYPE,
} from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import { getMailSidebarFolders } from "@/app/(app)/[emailAccountId]/mail/outlook-folder-list";
import { useIsLargeScreen } from "@/hooks/use-mobile";
import { getEmailTerminology } from "@/utils/terminology";
import { MailShellSidebar } from "@/app/(app)/[emailAccountId]/mail/MailShellSidebar";
import { MailSplitTabs } from "@/app/(app)/[emailAccountId]/mail/MailSplitTabs";
import { SelectAllCheckbox } from "@/app/(app)/[emailAccountId]/mail/SelectAllCheckbox";
import { MailReaderPane } from "@/app/(app)/[emailAccountId]/mail/MailReaderPane";
import { MailTitlebarNav } from "@/app/(app)/[emailAccountId]/mail/MailTitlebarNav";
import {
  SearchAnswerCard,
  useSearchAnswer,
} from "@/app/(app)/[emailAccountId]/mail/SearchAnswerCard";
import { ScheduledEmailList } from "@/app/(app)/[emailAccountId]/mail/ScheduledEmailList";
import { SnoozedThreadList } from "@/app/(app)/[emailAccountId]/mail/SnoozedThreadList";
import type { MailboxItem } from "@/app/(app)/[emailAccountId]/mail/MailboxItemContextMenu";
import { ListSenderCommands } from "@/app/(app)/[emailAccountId]/mail/ListSenderCommands";
import { extractEmailAddress } from "@/utils/email";
import { LabelPickerDialog } from "@/app/(app)/[emailAccountId]/mail/LabelPickerDialog";
import { ThreadList } from "@/app/(app)/[emailAccountId]/mail/ThreadList";
import { InboxStyleCard } from "@/app/(app)/[emailAccountId]/mail/InboxStylePicker";
import { CueLabelsCard } from "@/components/CueLabelsCleanup";
import { WhatsNewTour } from "@/app/(app)/[emailAccountId]/mail/WhatsNewTour";
import {
  MailListPlaceholder,
  MailLoadingNote,
} from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { useTranslateThread } from "@/app/(app)/[emailAccountId]/mail/use-thread-translation";
import { printThread } from "@/app/(app)/[emailAccountId]/mail/print-thread";
import { GmailLabel } from "@/utils/gmail/label";
import {
  getComposeTargetMessageId,
  getActiveThreadIndex,
  getSearchFocus,
  getNextThreadAfterRemoval,
  resolveThreadActionTargets,
} from "@/app/(app)/[emailAccountId]/mail/thread-list-behavior";
import {
  getListThreadKey,
  getListThreadSelection,
  getThreadSelectionKey,
  type MailLayoutMode,
  type ThreadSelection,
} from "@/app/(app)/[emailAccountId]/mail/types";
import type { ThreadMessage } from "@/components/email-list/types";
import { useMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-mail-threads";
import { useCombinedMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-combined-mail-threads";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useThreadActions } from "@/app/(app)/[emailAccountId]/mail/use-thread-actions";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { MailProductFrame } from "@inboxzero/mail-ui/MailProductFrame";
import { MailEngineConnectionBanner } from "@/utils/mail-engine/MailEngineConnectionBanner";
import { useThreadSelection } from "@/app/(app)/[emailAccountId]/mail/use-thread-selection";
import { useWarmNeighbourThreads } from "@/app/(app)/[emailAccountId]/mail/use-warm-neighbour-threads";
import { useMailPerformanceTelemetry } from "@/app/(app)/[emailAccountId]/mail/use-mail-performance-telemetry";
import {
  isThreadArchived,
  isThreadImportant,
  isThreadOnlyIn,
  isThreadUnread,
} from "@/app/(app)/[emailAccountId]/mail/read-state";
import { MailLayout, MailSplitFilterKind } from "@/generated/prisma/enums";
import { useSidebar } from "@/components/ui/sidebar";
import { useChat } from "@/providers/ChatProvider";
import { useAtomValue, useSetAtom } from "jotai";
import {
  commandPaletteOpenAtom,
  mailCommandContextAtom,
  senderCommandContextAtom,
  shortcutsDialogOpenAtom,
} from "@/store/command-palette";
import {
  EmailAccountScopeProvider,
  useAccount,
} from "@/providers/EmailAccountProvider";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { getOpenInMailboxLabel } from "@/utils/url";
import { useEmailLabels } from "@/providers/EmailLabelsProvider";
import { undoLatestToast } from "@/components/Toast";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useLabels } from "@/hooks/useLabels";
import { useFolders } from "@/hooks/useFolders";
import { useMailSettings } from "@/hooks/useMailSettings";
import { useAccounts } from "@/hooks/useAccounts";
import { AllInboxesFailedNotice } from "@/app/(app)/[emailAccountId]/mail/AllInboxesFailedNotice";
import { useThread } from "@/hooks/useThread";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import type { ShortcutHandlers } from "@/lib/shortcuts/registry";
import { updateMailPreferencesAction } from "@/utils/actions/mail-split";
import type { UpdateMailPreferencesBody } from "@/utils/actions/mail-split.validation";
import { submitConversationChange } from "@/utils/mail-engine/submit-conversations";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import {
  getPortableLabelSplits,
  OTHER_SPLIT_ID,
  otherMailSplitQuery,
  mailSplitToThreadsQuery,
  mailTypeToThreadsQuery,
} from "@/utils/split-inbox/split-query";
import { isInboxStyleLandingSplit } from "@/utils/split-inbox/inbox-styles";
import { getActionErrorMessage } from "@/utils/error";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
import {
  getMailNavView,
  type MailSlugs,
  useMailRoute,
  useMailSlugs,
} from "@/app/(app)/[emailAccountId]/mail/use-mail-route";
import {
  buildMailPath,
  getSplitSlugs,
  mailPathForAccount,
  type MailUrlView,
  resolveSlug,
} from "@/utils/mail-url";
import { redirectToSafeUrl } from "@/utils/redirect";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { LoadingContent } from "@/components/LoadingContent";
import { useTeamCommentsAvailable } from "@/components/team-comments/use-team-comments-available";
import { getEmailMessageCellActions } from "@/components/EmailMessageCellActions";
import type { ThreadsQuery } from "@/utils/threads/validation";

// Module-level so an "empty" reader doesn't hand children a new array each render.
const NO_MESSAGES: ThreadMessage[] = [];
const NO_LABELS = {};
const NO_SLUGS: MailSlugs = { labels: new Map(), folders: new Map() };
const INBOX_VIEW: MailUrlView = { kind: "inbox" };

/**
 * Owns the mail screen's URL, thread list, selection, and triage state, and
 * composes the sidebar, list, and reader from memoized parts. J/K and engine
 * snapshots re-render this component, so everything passed down is kept
 * referentially stable and only the parts whose inputs changed re-render.
 */
export function MailShell() {
  const { emailAccount, emailAccountId, userEmail, provider, accountIds } =
    useAccount();
  const { data: accountsData } = useAccounts();
  const isGoogle = isGoogleProvider(provider);
  const isOutlook = isMicrosoftProvider(provider);
  const { userLabels } = useEmailLabels();
  const {
    userLabels: allLabels,
    mutate: mutateLabels,
    isLoading: labelsLoading,
  } = useLabels();
  const { folders, isLoading: foldersLoading } = useFolders(provider);
  const { data: settings, mutate: mutateSettings } = useMailSettings();
  const { toggleSidebar, setOpen: setSidebarOpen } = useSidebar();
  const { submitTextMessage, chatId, setNewChat } = useChat();
  // A question waits for a conversation to exist; sent before one, it's dropped.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingQuestion || !chatId) return;
    setPendingQuestion(null);
    submitTextMessage(pendingQuestion).catch(() => undefined);
  }, [pendingQuestion, chatId, submitTextMessage]);
  const router = useRouter();
  const isPaletteOpen = useAtomValue(commandPaletteOpenAtom);
  const isHelpOpen = useAtomValue(shortcutsDialogOpenAtom);
  const setIsHelpOpen = useSetAtom(shortcutsDialogOpenAtom);
  const senderCommandContext = useAtomValue(senderCommandContextAtom);
  const setMailCommandContext = useSetAtom(mailCommandContextAtom);
  // The side panel viewer owns the triage keys while it's open, so this screen
  // stands down rather than both archiving the same keystroke.
  const { threadId: sidePanelThreadId } = useDisplayedEmail();
  const client = useOptionalMailClient();

  // The view lives in the address (`/mail/u/0/label/receipts/{threadId}`);
  // slugs resolve to ids once the account's labels, folders and tabs load.
  const { location: mailLocation, updateLocation } = useMailRoute();
  const mailSlugs = useMailSlugs(allLabels, folders);
  const splitSlugs = useMemo(
    () => getSplitSlugs(settings?.splits ?? []),
    [settings?.splits],
  );
  const routeView = mailLocation.view ?? INBOX_VIEW;
  const openThreadId = mailLocation.threadId ?? null;
  const openThreadAccountId =
    mailLocation.threadAccountIndex == null
      ? null
      : (accountIds[mailLocation.threadAccountIndex] ?? null);
  // Renaming the open label or tab changes its slug under the address; the
  // last slug that resolved keeps pointing at it until the address catches up.
  const [lastResolvedSlug, setLastResolvedSlug] = useState<{
    kind: "label" | "folder" | "split";
    slug: string;
    id: string;
  } | null>(null);
  const resolveRouteSlug = (
    kind: "label" | "folder" | "split",
    slugs: ReadonlyMap<string, string>,
  ) => {
    if (routeView.kind !== kind) return null;
    const id = resolveSlug(slugs, routeView.slug);
    if (id) return id;
    return lastResolvedSlug?.kind === kind &&
      lastResolvedSlug.slug === routeView.slug &&
      slugs.has(lastResolvedSlug.id)
      ? lastResolvedSlug.id
      : null;
  };
  const routeLabelId = resolveRouteSlug("label", mailSlugs.labels);
  const routeFolderId = resolveRouteSlug("folder", mailSlugs.folders);
  // A slug that never resolves is taken as a provider id, which is what links
  // from before readable addresses carry.
  const scopeLabelId =
    routeView.kind === "label" ? (routeLabelId ?? routeView.slug) : null;
  const scopeFolderId =
    routeView.kind === "folder" ? (routeFolderId ?? routeView.slug) : null;
  const scopeType =
    routeView.kind === "type"
      ? routeView.type
      : routeView.kind === "label" || routeView.kind === "folder"
        ? routeView.kind
        : null;
  const activeSplitId = resolveRouteSlug("split", splitSlugs);
  const searchParam = routeView.kind === "search" ? routeView.q : null;
  // Until names load, a slug can't be told from an id, so nothing is fetched.
  const isResolvingRoute =
    (routeView.kind === "label" && !routeLabelId && labelsLoading) ||
    (routeView.kind === "folder" && !routeFolderId && foldersLoading) ||
    (routeView.kind === "split" && !settings);
  const viewBeforeSearchRef = useRef<MailUrlView | null>(null);

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isDesktopApp, setIsDesktopApp] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isTourOpen, setIsTourOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const isLargeScreen = useIsLargeScreen();
  const [labelPicker, setLabelPicker] = useState<{
    mode: "label" | "move";
    targets: ThreadSelection[];
  } | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string>();
  const [replyAll, setReplyAll] = useState(false);
  const [forwardToMessageId, setForwardToMessageId] = useState<string>();
  const pendingComposeRequest = useRef<{
    mode: "reply" | "forward";
    threadKey: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocusRef = useRef(false);

  useEffect(() => {
    setIsDesktopApp(Boolean(getInboxZeroDesktopApp()));
  }, []);

  const isAllAccounts = Boolean(mailLocation.allInboxes);
  const setOpenThread = useCallback(
    (selection: ThreadSelection | null) => {
      setIsMenuOpen(false);
      const threadAccountIndex =
        isAllAccounts && selection
          ? accountIds.indexOf(selection.emailAccountId)
          : -1;
      updateLocation((current) => ({
        ...current,
        threadId: selection?.threadId ?? null,
        threadAccountIndex: threadAccountIndex >= 0 ? threadAccountIndex : null,
      }));
      return Promise.resolve();
    },
    [accountIds, isAllAccounts, updateLocation],
  );

  // Old links carry a label's provider id, a just-created tab is addressed by
  // id until its slug loads, and a rename changes the slug: in each case the
  // address is swapped for the current slug once it's known.
  const routeSlugId = routeLabelId ?? routeFolderId ?? activeSplitId;
  useEffect(() => {
    if (
      !routeSlugId ||
      (routeView.kind !== "label" &&
        routeView.kind !== "folder" &&
        routeView.kind !== "split")
    )
      return;
    const kind = routeView.kind;
    const slug = {
      label: mailSlugs.labels,
      folder: mailSlugs.folders,
      split: splitSlugs,
    }[kind].get(routeSlugId);
    if (!slug) return;
    setLastResolvedSlug((previous) =>
      previous?.kind === kind &&
      previous.slug === slug &&
      previous.id === routeSlugId
        ? previous
        : { kind, slug, id: routeSlugId },
    );
    if (slug === routeView.slug) return;
    updateLocation((current) => ({ ...current, view: { kind, slug } }));
  }, [routeSlugId, routeView, mailSlugs, splitSlugs, updateLocation]);
  const combinedAccounts = useMemo(
    () => getAllInboxesAccounts(accountsData?.emailAccounts ?? []),
    [accountsData?.emailAccounts],
  );
  const accountColorIndexById = useMemo(
    () =>
      Object.fromEntries(
        combinedAccounts.map((account, index) => [account.id, index]),
      ),
    [combinedAccounts],
  );
  const accountLayout: MailLayoutMode =
    settings?.layout === MailLayout.SPLIT ? "split" : "list";
  // A split reader needs the room `lg` gives it; below that the saved choice
  // waits, rather than leaving a phone a reader a hundred pixels wide.
  const canSplit = !isAllAccounts && isLargeScreen;
  const layout = canSplit ? accountLayout : "list";
  const expandedPreview = settings?.expandedPreview ?? false;

  // Written through the SWR cache rather than mirrored in local state, so the
  // preference has one source of truth and every reader sees the new value.
  const updatePreferences = useCallback(
    (preferences: UpdateMailPreferencesBody) => {
      if (!settings) return;
      const loadedSettings = settings;

      mutateSettings(
        async (current) => {
          const result = await updateMailPreferencesAction(
            emailAccountId,
            preferences,
          );
          // Thrown so SWR rolls the optimistic value back rather than leaving
          // the UI showing a preference the server never accepted.
          if (result?.serverError || result?.validationErrors)
            throw new Error(getActionErrorMessage(result));
          return { ...(current ?? loadedSettings), ...preferences };
        },
        {
          optimisticData: (current) => ({
            ...(current ?? loadedSettings),
            ...preferences,
          }),
          revalidate: false,
          rollbackOnError: true,
        },
      ).catch((error) => {
        toast.error(
          error instanceof Error ? error.message : "Couldn't save that",
        );
      });
    },
    [emailAccountId, mutateSettings, settings],
  );

  const toggleLayout = useCallback(
    () =>
      updatePreferences({
        layout: layout === "split" ? MailLayout.LIST : MailLayout.SPLIT,
      }),
    [layout, updatePreferences],
  );

  const togglePreview = useCallback(
    () => updatePreferences({ expandedPreview: !expandedPreview }),
    [expandedPreview, updatePreferences],
  );

  // A sidebar selection scopes the whole list, which replaces the split tabs —
  // splits are a way of slicing the inbox, not of slicing an arbitrary view.
  // Resolved once so the tab bar and the fetched rows can't disagree.
  const scopeQuery: ThreadsQuery | null = useMemo(() => {
    if (scopeLabelId) return { labelId: scopeLabelId };
    if (scopeFolderId) return { folderId: scopeFolderId };
    if (scopeType && scopeType !== "inbox")
      return mailTypeToThreadsQuery(scopeType);
    return null;
  }, [scopeFolderId, scopeLabelId, scopeType]);
  const isScoped = !isAllAccounts && scopeQuery !== null;

  const searchEditIdentity = JSON.stringify([
    emailAccountId,
    isAllAccounts,
    searchParam,
    scopeType,
    scopeLabelId,
    scopeFolderId,
  ]);
  const [searchDraft, setSearchDraft] = useState<{
    identity: string;
    value: string;
  }>();
  if (searchDraft && searchDraft.identity !== searchEditIdentity)
    setSearchDraft(undefined);
  const searchValue =
    (searchDraft?.identity === searchEditIdentity
      ? searchDraft.value
      : searchParam) ?? "";
  const searchQuery = searchValue.trim() || null;
  // Scheduled sends live in our own database, so this view has no thread
  // list to fetch.
  const isScheduledView =
    !isAllAccounts && !searchQuery && scopeType === MAIL_SCHEDULED_TYPE;
  // The mailbox doesn't know what's snoozed or until when; our database does.
  const isSnoozedView =
    !isAllAccounts && !searchQuery && scopeType === MAIL_SNOOZED_TYPE;
  const [settledSearch, setSettledSearch] = useState(searchQuery);
  useEffect(() => {
    const timeout = setTimeout(() => setSettledSearch(searchQuery), 250);
    return () => clearTimeout(timeout);
  }, [searchQuery]);
  const searchSettled = !searchQuery || searchQuery === settledSearch;
  // Search has its own address (`/mail/u/0/search?q=…`); clearing it returns
  // to the view it was started from.
  const setSearch = useCallback(
    (value: string) => {
      const q = value.trim() || null;
      setSearchDraft(undefined);
      setSettledSearch(q);
      updateLocation((current) => {
        const view = current.view ?? INBOX_VIEW;
        if (q) {
          if (view.kind !== "search") viewBeforeSearchRef.current = view;
          return { ...current, view: { kind: "search", q } };
        }
        if (view.kind !== "search") return current;
        const previous = viewBeforeSearchRef.current ?? INBOX_VIEW;
        viewBeforeSearchRef.current = null;
        return { ...current, view: previous };
      });
      return Promise.resolve();
    },
    [updateLocation],
  );
  const onSearchChange = useCallback(
    (value: string) => setSearchDraft({ identity: searchEditIdentity, value }),
    [searchEditIdentity],
  );

  const combinedLabelSplits = useMemo(
    () => getPortableLabelSplits(settings?.splits ?? [], userLabels),
    [settings?.splits, userLabels],
  );

  const splits = useMemo(
    () =>
      [
        ...(settings?.splits ?? []).map((split) => ({
          ...split,
          name:
            isGoogle && split.name.trim().toLowerCase() === "other"
              ? `${split.name} (custom)`
              : split.name,
        })),
        ...(isGoogle && !isAllAccounts
          ? [
              {
                id: OTHER_SPLIT_ID,
                name: "Other",
                matchAll: true,
                filters: [],
              },
            ]
          : []),
      ].filter(
        (split) =>
          !isAllAccounts ||
          split.filters.every(
            (filter) => filter.kind === MailSplitFilterKind.UNREAD,
          ) ||
          combinedLabelSplits.some((portable) => portable.id === split.id),
      ),
    [settings?.splits, isAllAccounts, combinedLabelSplits, isGoogle],
  );
  const splitTabs = useMemo(
    () =>
      splits.map((split) => ({
        ...split,
        deletable: split.filters.length > 0,
      })),
    [splits],
  );
  // With an inbox style chosen, mail opens on its Primary or Focused tab
  // rather than All, which shows the same mail and more.
  const activeSplit =
    splits.find((split) => split.id === activeSplitId) ??
    splits.find(isInboxStyleLandingSplit) ??
    splits[0];
  const displayedActiveSplitId = activeSplit?.id ?? null;
  // The tab mail opens on reads as plain `/inbox`; the others by their slug.
  const landingSplitId =
    (splits.find(isInboxStyleLandingSplit) ?? splits[0])?.id ?? null;
  const setActiveSplitId = useCallback(
    (splitId: string | null) => {
      // A tab created a moment ago has no slug until settings reload; its id
      // holds the place and is swapped for the slug once it does.
      const slug = splitId ? (splitSlugs.get(splitId) ?? splitId) : undefined;
      updateLocation((current) => ({
        ...current,
        view:
          slug && splitId !== landingSplitId
            ? { kind: "split", slug }
            : INBOX_VIEW,
      }));
    },
    [landingSplitId, splitSlugs, updateLocation],
  );
  const activeCombinedLabelNames = combinedLabelSplits.find(
    (split) => split.id === displayedActiveSplitId,
  )?.labelNames;
  const query: ThreadsQuery = useMemo(() => {
    // Search overrides split/scope and covers the whole mailbox, matching
    // what Gmail's and Outlook's own search boxes do by default.
    if (searchQuery) return { q: searchQuery };
    if (scopeQuery) return scopeQuery;

    if (activeSplit?.id === OTHER_SPLIT_ID) return otherMailSplitQuery(splits);
    return activeSplit
      ? mailSplitToThreadsQuery(activeSplit)
      : { type: "inbox" };
  }, [searchQuery, scopeQuery, activeSplit, splits]);

  const accountThreadState = useMailThreads({
    emailAccountId,
    query,
    enabled:
      !isAllAccounts &&
      searchSettled &&
      !isScheduledView &&
      !isSnoozedView &&
      !isResolvingRoute,
  });
  const combinedThreadState = useCombinedMailThreads({
    accounts: combinedAccounts,
    emailAccountId,
    enabled: isAllAccounts && searchSettled,
    isUnread:
      !searchQuery &&
      !!activeSplit?.filters.length &&
      activeSplit.filters.every(
        (filter) => filter.kind === MailSplitFilterKind.UNREAD,
      ),
    labelNames: searchQuery ? undefined : activeCombinedLabelNames,
    searchQuery: searchQuery ?? undefined,
  });
  const { labelsByAccount } = combinedThreadState;
  const splitCountAccountIds = useMemo(
    () =>
      isAllAccounts
        ? combinedAccounts.map((account) => account.id)
        : [emailAccountId],
    [combinedAccounts, emailAccountId, isAllAccounts],
  );
  const {
    threads: remoteThreads,
    isLoading,
    error,
    hasMore,
    isLoadingMore,
    loadMore,
    refetch: refetchThreadList,
  } = isAllAccounts ? combinedThreadState : accountThreadState;
  const providerState = isAllAccounts
    ? combinedThreadState
    : accountThreadState;
  const hasProviderResponse = searchSettled && providerState.hasRemoteResponse;
  const threads = searchSettled ? remoteThreads : EMPTY_SEARCH_THREADS;
  const allInboxesFirstSyncMessage =
    isAllAccounts && combinedThreadState.firstSyncAccounts.length
      ? `Loading mail from ${combinedThreadState.firstSyncAccounts
          .map((account) => account.email)
          .join(", ")}…`
      : null;
  const isFirstSync = isAllAccounts
    ? Boolean(allInboxesFirstSyncMessage)
    : accountThreadState.isFirstSync;
  const listPlaceholderMessage = isAllAccounts
    ? (allInboxesFirstSyncMessage ?? "Loading your mail…")
    : `Loading your mail from ${isOutlook ? "Outlook" : "Gmail"}…`;
  const searchViewIdentity = JSON.stringify([
    emailAccountId,
    isAllAccounts,
    searchQuery,
  ]);
  const orderedIds = useStableOrderedIds(threads);
  const previousSearchFocus = useRef<
    ReturnType<typeof getSearchFocus> | undefined
  >(undefined);
  useLayoutEffect(() => {
    const next = getSearchFocus({
      previous: previousSearchFocus.current,
      view: searchQuery ? searchViewIdentity : null,
      focusedIndex,
      orderedIds,
    });
    previousSearchFocus.current = next;
    if (next.index !== focusedIndex) setFocusedIndex(next.index);
  }, [orderedIds, focusedIndex, searchQuery, searchViewIdentity]);
  const { data: searchAnswer } = useSearchAnswer(emailAccountId, searchParam);
  const searchFoundNothing = Boolean(
    searchQuery && hasProviderResponse && !threads.length,
  );
  const isSearchCommitted = !!searchParam && searchQuery === searchParam.trim();
  let emptySearchMessage: string | undefined;
  if (searchFoundNothing) emptySearchMessage = "No emails in this view";
  // A committed search's card above speaks for it: the answer leads to the
  // mail, and with no answer it offers to ask in chat instead.
  if ((searchAnswer || searchFoundNothing) && isSearchCommitted)
    emptySearchMessage = "";

  const selection = useThreadSelection(orderedIds);

  const clampIndex = useCallback(
    (index: number) =>
      Math.min(Math.max(0, index), Math.max(0, threads.length - 1)),
    [threads.length],
  );
  const openThreadSelection = useMemo<ThreadSelection | null>(() => {
    if (!openThreadId) return null;
    const ownerEmailAccountId = isAllAccounts
      ? openThreadAccountId
      : emailAccountId;
    if (!ownerEmailAccountId) return null;
    return {
      emailAccountId: ownerEmailAccountId,
      threadId: openThreadId,
    };
  }, [emailAccountId, isAllAccounts, openThreadAccountId, openThreadId]);
  const openThreadKey = isAllAccounts
    ? getThreadSelectionKey(openThreadSelection)
    : openThreadId;
  const readerEmailAccount = openThreadSelection
    ? openThreadSelection.emailAccountId === emailAccountId
      ? emailAccount
      : accountsData?.emailAccounts.find(
          (account) => account.id === openThreadSelection.emailAccountId,
        )
    : emailAccount;
  const clampedIndex = getActiveThreadIndex({
    threadIds: orderedIds,
    focusedIndex,
    openThreadId: openThreadKey,
  });
  const focusedThread = threads[clampedIndex];
  const openThread = openThreadKey
    ? threads.find((thread) => getListThreadKey(thread) === openThreadKey)
    : undefined;
  const readAttemptedForOpenThread = useRef<string | null>(null);
  useWarmNeighbourThreads({ threads, openThreadKey, emailAccountId });

  // Defer the pair as one value: rendering a new id with the previous account
  // would be worse than fetching eagerly when J/K moves between account rows.
  const deferredReaderSelection = useDeferredValue(openThreadSelection);
  const readerThreadKey = getThreadSelectionKey(deferredReaderSelection);
  const openReaderThreadKey = getThreadSelectionKey(openThreadSelection);
  useLayoutEffect(() => {
    if (openReaderThreadKey) setIsMenuOpen(false);
  }, [openReaderThreadKey]);
  const readerSelectionSettled = readerThreadKey === openReaderThreadKey;
  const [visibleReaderThreadKey, setVisibleReaderThreadKey] =
    useState<string>();
  useMailPerformanceTelemetry({
    openThreadKey: openReaderThreadKey,
    visibleThreadKey: visibleReaderThreadKey,
  });
  const {
    data: openThreadData,
    error: openThreadError,
    isLoading: isOpenThreadLoading,
    mutate: refetchOpenThread,
    localAvailability: openThreadLocalAvailability,
  } = useThread(
    {
      id: deferredReaderSelection?.threadId ?? null,
      emailAccountId: deferredReaderSelection?.emailAccountId,
    },
    { includeDrafts: true, localMail: true },
  );
  // Withheld until the deferred id catches up, so a fast J/K can't pair the new
  // thread's header with the previous thread's body.
  const openMessages = readerSelectionSettled
    ? (openThreadData?.thread.messages ?? NO_MESSAGES)
    : NO_MESSAGES;
  const openExternalUrl = useMemo(() => {
    const message = openMessages.at(-1);
    if (!message || !readerEmailAccount) return;
    return getEmailMessageCellActions({
      externalUrl: message.externalUrl,
      messageId: message.id,
      provider: readerEmailAccount.account.provider,
      threadId: message.threadId,
      userEmail: readerEmailAccount.email,
    })?.openUrl;
  }, [openMessages, readerEmailAccount]);
  const translateThread = useTranslateThread();
  const readerEmailAccountId = readerEmailAccount?.id;
  const translateOpenThread = useMemo(() => {
    const threadId = openMessages.at(-1)?.threadId;
    const messageIds = openMessages
      .filter((message) => !message.labelIds?.includes(GmailLabel.DRAFT))
      .map((message) => message.id);
    if (!readerEmailAccountId || !threadId || !messageIds.length) return;
    return () => {
      translateThread({
        emailAccountId: readerEmailAccountId,
        threadId,
        messageIds,
      });
    };
  }, [openMessages, readerEmailAccountId, translateThread]);
  const printOpenThread = useMemo(() => {
    const printable = openMessages.filter(
      (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
    );
    if (!printable.length) return;
    return () =>
      printThread({
        subject: printable[0].headers.subject || "(no subject)",
        messages: printable,
      });
  }, [openMessages]);
  const teamCommentsAvailable = useTeamCommentsAvailable(readerEmailAccountId);
  const openTeamComments = useMemo(
    () =>
      // The listener mounts with the thread's messages, so an earlier request
      // would be dropped.
      openThreadId &&
      readerSelectionSettled &&
      openMessages.length > 0 &&
      teamCommentsAvailable
        ? () => document.dispatchEvent(new Event("team-comments:open"))
        : undefined,
    [
      openThreadId,
      readerSelectionSettled,
      openMessages.length,
      teamCommentsAvailable,
    ],
  );
  const readerTarget = useMemo(() => {
    if (!openThreadKey || !openThreadSelection || !readerSelectionSettled)
      return;
    const messageIds = [...new Set(openMessages.map((message) => message.id))];
    if (!messageIds.length) return;
    return {
      emailAccountId: openThreadSelection.emailAccountId,
      key: openThreadKey,
      messageIds,
      threadId: openThreadSelection.threadId,
    };
  }, [
    openMessages,
    openThreadKey,
    openThreadSelection,
    readerSelectionSettled,
  ]);
  const actionTargets = useMemo(() => {
    // Navigation can outpace the visible reader; do not act on an unseen email.
    if (
      openReaderThreadKey &&
      openReaderThreadKey !== visibleReaderThreadKey &&
      !selection.hasSelection
    )
      return [];
    const listTargets = threads.map((thread) => ({
      key: getListThreadKey(thread),
      messages: thread.messages,
      selection: getListThreadSelection(thread, emailAccountId),
    }));
    const openTarget =
      openThreadKey && openThreadSelection && (openThread || readerTarget)
        ? {
            key: openThreadKey,
            messages: openThread?.messages ?? openMessages,
            selection: openThreadSelection,
          }
        : undefined;

    return resolveThreadActionTargets({
      focusedKey: focusedThread ? getListThreadKey(focusedThread) : undefined,
      listTargets,
      openTarget,
      selectedKeys: [...selection.selectedIds],
    });
  }, [
    emailAccountId,
    focusedThread,
    openReaderThreadKey,
    visibleReaderThreadKey,
    selection.hasSelection,
    openMessages,
    openThread,
    openThreadKey,
    openThreadSelection,
    readerTarget,
    selection.selectedIds,
    threads,
  ]);
  const {
    archive,
    moveToInbox,
    trash,
    markSpam,
    markNotSpam,
    restoreFromTrash,
    setImportantState,
    setReadState,
    setStarredState,
    snooze,
    undo,
  } = useThreadActions({
    emailAccountId,
    readerTarget,
    threads,
  });
  const markRead = useCallback(
    (threadKeys: string[]) => setReadState(threadKeys, true, false),
    [setReadState],
  );
  const rowActions = useMemo(
    () => ({
      archive: (key: string) => archive([key]),
      moveToInbox: (key: string) => moveToInbox([key]),
      trash: (key: string) => trash([key]),
      setRead: (key: string, read: boolean) => setReadState([key], read),
      setStarred: (key: string, starred: boolean) =>
        setStarredState([key], starred),
      snooze: (key: string, until: Date) => snooze([key], until),
    }),
    [archive, moveToInbox, trash, setReadState, setStarredState, snooze],
  );
  const composeTargetMessageId = getComposeTargetMessageId(openMessages);
  const requestReaderReply = useCallback(() => {
    setReplyAll(false);
    const messageId = composeTargetMessageId;
    if (messageId) {
      pendingComposeRequest.current = null;
      setForwardToMessageId(undefined);
      setReplyToMessageId(messageId);
      focusOpenReply();
      return;
    }

    if (openReaderThreadKey) {
      pendingComposeRequest.current = {
        mode: "reply",
        threadKey: openReaderThreadKey,
      };
    }
  }, [composeTargetMessageId, openReaderThreadKey]);

  const requestReaderForward = useCallback(() => {
    const messageId = composeTargetMessageId;
    if (messageId) {
      pendingComposeRequest.current = null;
      setReplyToMessageId(undefined);
      setForwardToMessageId(messageId);
      return;
    }

    if (openReaderThreadKey) {
      pendingComposeRequest.current = {
        mode: "forward",
        threadKey: openReaderThreadKey,
      };
    }
  }, [composeTargetMessageId, openReaderThreadKey]);

  useEffect(() => {
    const pendingRequest = pendingComposeRequest.current;
    if (!pendingRequest) return;
    if (pendingRequest.threadKey !== openReaderThreadKey) {
      pendingComposeRequest.current = null;
      return;
    }

    const messageId = composeTargetMessageId;
    if (!readerSelectionSettled || !messageId) return;

    pendingComposeRequest.current = null;
    if (pendingRequest.mode === "reply") {
      setForwardToMessageId(undefined);
      setReplyToMessageId(messageId);
    } else {
      setReplyToMessageId(undefined);
      setForwardToMessageId(messageId);
    }
  }, [composeTargetMessageId, openReaderThreadKey, readerSelectionSettled]);

  // Let the fetched snapshot decide the initial read state. Once marking has
  // been attempted, the optimistically patched row is the copy that stays in
  // step while the fetched snapshot may still be stale.
  const initialReadStateMessages = openMessages.length
    ? openMessages
    : (openThread?.messages ?? openMessages);
  const readStateMessages =
    readAttemptedForOpenThread.current === openThreadKey
      ? (openThread?.messages ?? openMessages)
      : initialReadStateMessages;
  const isOpenThreadUnread = isThreadUnread(readStateMessages);

  const labelHref = useCallback(
    (labelId: string) => {
      // In All Inboxes the open thread may belong to another account, whose
      // label names aren't loaded here; its id resolves on arrival.
      const accountId = openThreadSelection?.emailAccountId ?? emailAccountId;
      return mailPathForAccount(accountIds, accountId, {
        view: getMailNavView(
          { kind: "label", labelId },
          accountId === emailAccountId ? mailSlugs : NO_SLUGS,
        ),
      });
    },
    [
      accountIds,
      emailAccountId,
      mailSlugs,
      openThreadSelection?.emailAccountId,
    ],
  );

  const getOpenThreadKey = useStableCallback(() => openThreadKey);
  const advanceReaderPast = useStableCallback(
    (currentThreadKey: string, removedThreadKeys: string[]) => {
      const nextThread = getNextThreadAfterRemoval({
        threadIds: orderedIds,
        currentThreadId: currentThreadKey,
        currentThreadIndex: focusedIndex,
        removedThreadIds: removedThreadKeys,
      });
      setFocusedIndex(nextThread?.index ?? 0);
      const nextRow = threads.find(
        (thread) => getListThreadKey(thread) === nextThread?.id,
      );
      setOpenThread(
        nextRow ? getListThreadSelection(nextRow, emailAccountId) : null,
      );
    },
  );
  const runOn = useStableCallback(
    async (
      action: (ids: string[]) => Promise<string[]>,
      removeFromList: boolean,
      autoAdvanceReader = false,
    ) => {
      const ids = actionTargets.map((target) => target.key);
      if (!ids.length) return;
      const hadSelection = selection.hasSelection;
      const queuedThreadKeys = await action(ids);
      if (!queuedThreadKeys.length) return;
      if (
        removeFromList &&
        openThreadKey &&
        queuedThreadKeys.includes(openThreadKey) &&
        // The user may have opened another thread while the action was queued.
        getOpenThreadKey() === openThreadKey
      ) {
        if (autoAdvanceReader) {
          advanceReaderPast(openThreadKey, queuedThreadKeys);
        } else {
          setOpenThread(null);
        }
      }
      selection.clear();
      if (hadSelection && queuedThreadKeys.length < ids.length) {
        const queued = new Set(queuedThreadKeys);
        for (const id of ids) {
          if (queued.has(id)) continue;
          const index = orderedIds.indexOf(id);
          if (index >= 0) selection.toggle(index);
        }
      }
    },
  );

  const openAt = useStableCallback((index: number) => {
    const thread = threads[index];
    if (!thread) return;
    setFocusedIndex(index);
    setReplyToMessageId(undefined);
    setForwardToMessageId(undefined);
    selection.clear();
    setOpenThread(getListThreadSelection(thread, emailAccountId));
  });

  const move = useCallback(
    (delta: number) => {
      const next = clampIndex(clampedIndex + delta);
      setFocusedIndex(next);
      // Once a reader is open, navigation keeps its content and position in
      // step. A closed list view still lets J/K move the row cursor alone —
      // there the cursor still signals intent, so warm the row for Enter.
      const nextThread = threads[next];
      if ((layout === "split" || openThreadId) && nextThread) {
        setReplyToMessageId(undefined);
        setForwardToMessageId(undefined);
        setOpenThread(getListThreadSelection(nextThread, emailAccountId));
      }
    },
    [
      clampIndex,
      clampedIndex,
      threads,
      layout,
      openThreadId,
      setOpenThread,
      emailAccountId,
    ],
  );

  const extendSelection = useCallback(
    (delta: number) => {
      const next = clampIndex(clampedIndex + delta);
      selection.extendTo(next, clampedIndex);
      setFocusedIndex(next);
    },
    [clampIndex, clampedIndex, selection],
  );

  useEffect(() => {
    if (!openReaderThreadKey) {
      readAttemptedForOpenThread.current = null;
      return;
    }
    if (
      !openThreadKey ||
      !readerSelectionSettled ||
      !openMessages.length ||
      readAttemptedForOpenThread.current === openThreadKey
    ) {
      return;
    }
    if (!isOpenThreadUnread) {
      // A cached read snapshot can arrive before a fresh unread response.
      return;
    }

    // Remember the durable attempt so this reader doesn't queue duplicates
    // while the outbox is waiting for connectivity or provider recovery.
    readAttemptedForOpenThread.current = openThreadKey;
    markRead([openThreadKey]);
  }, [
    isOpenThreadUnread,
    markRead,
    openMessages.length,
    openReaderThreadKey,
    openThreadKey,
    readerSelectionSettled,
  ]);
  const archiveTargets = useCallback(
    () => runOn(archive, true, true),
    [archive, runOn],
  );
  // Archiving again would be a no-op, so archived targets offer the way back.
  const moveToInboxTargets = useCallback(
    () => runOn(moveToInbox, true, true),
    [moveToInbox, runOn],
  );
  const targetsArchived =
    actionTargets.length > 0 &&
    actionTargets.every((target) => isThreadArchived(target.messages));
  // Archiving from Trash or Spam would leave it there, so those offer the way out.
  const targetsTrashed =
    actionTargets.length > 0 &&
    actionTargets.every((target) =>
      isThreadOnlyIn(target.messages, GmailLabel.TRASH),
    );
  const targetsSpam =
    actionTargets.length > 0 &&
    actionTargets.every((target) =>
      isThreadOnlyIn(target.messages, GmailLabel.SPAM),
    );
  const restoreTargets = useCallback(
    () => runOn(restoreFromTrash, true, true),
    [restoreFromTrash, runOn],
  );
  const notSpamTargets = useCallback(
    () => runOn(markNotSpam, true, true),
    [markNotSpam, runOn],
  );
  const allImportant =
    actionTargets.length > 0 &&
    actionTargets.every((target) => isThreadImportant(target.messages));
  const importantTargets = useCallback(
    () => runOn((ids) => setImportantState(ids, !allImportant), false),
    [allImportant, runOn, setImportantState],
  );
  const trashTargets = useCallback(
    () => runOn(trash, true, true),
    [runOn, trash],
  );
  const markSpamTargets = useCallback(
    () => runOn(markSpam, true, true),
    [markSpam, runOn],
  );
  const markReadTargets = useCallback(
    () => runOn(markRead, false),
    [markRead, runOn],
  );
  const markUnreadTargets = useStableCallback(() =>
    runOn((ids) => {
      if (openThreadKey && ids.includes(openThreadKey)) {
        readAttemptedForOpenThread.current = openThreadKey;
      }
      return setReadState(ids, false);
    }, true),
  );
  const allStarred =
    actionTargets.length > 0 &&
    actionTargets.every((target) => isThreadStarred(target.messages));
  const starTargets = useCallback(
    () => runOn((ids) => setStarredState(ids, !allStarred), false),
    [runOn, setStarredState, allStarred],
  );
  const snoozeTargets = useCallback(
    (until: Date) => runOn((ids) => snooze(ids, until), true, true),
    [runOn, snooze],
  );
  const currentLabelTargets = useMemo(
    () => actionTargets.map((target) => target.selection),
    [actionTargets],
  );
  const labelAccountId = currentLabelTargets[0]?.emailAccountId;
  const labelAccount =
    labelAccountId === emailAccountId
      ? emailAccount
      : accountsData?.emailAccounts.find(
          (account) => account.id === labelAccountId,
        );
  // Outlook categories use the same engine membership command as Gmail labels.
  const canLabel =
    currentLabelTargets.length > 0 &&
    (isGoogleProvider(labelAccount?.account.provider) ||
      isMicrosoftProvider(labelAccount?.account.provider)) &&
    currentLabelTargets.every(
      (target) => target.emailAccountId === labelAccountId,
    );
  const openLabelPicker = useStableCallback(() => {
    if (canLabel)
      setLabelPicker({ mode: "label", targets: currentLabelTargets });
  });
  const openMovePicker = useStableCallback(() => {
    if (canLabel)
      setLabelPicker({ mode: "move", targets: currentLabelTargets });
  });
  const singleActionTarget =
    actionTargets.length === 1 ? actionTargets.at(0) : undefined;
  const requestForwardTarget = useStableCallback(() => {
    if (!singleActionTarget) return;
    if (singleActionTarget.key === openThreadKey) {
      requestReaderForward();
      return;
    }

    const targetIndex = threads.findIndex(
      (thread) => getListThreadKey(thread) === singleActionTarget.key,
    );
    const targetThreadKey = getThreadSelectionKey(singleActionTarget.selection);
    if (!targetThreadKey) return;
    pendingComposeRequest.current = {
      mode: "forward",
      threadKey: targetThreadKey,
    };
    if (targetIndex >= 0) setFocusedIndex(targetIndex);
    setReplyToMessageId(undefined);
    setForwardToMessageId(undefined);
    setOpenThread(singleActionTarget.selection);
  });
  const pickerAccount =
    labelPicker?.targets[0]?.emailAccountId === emailAccountId
      ? emailAccount
      : accountsData?.emailAccounts.find(
          (account) => account.id === labelPicker?.targets[0]?.emailAccountId,
        );
  const senderAccount =
    singleActionTarget?.selection.emailAccountId === emailAccountId
      ? emailAccount
      : accountsData?.emailAccounts.find(
          (account) =>
            account.id === singleActionTarget?.selection.emailAccountId,
        );
  const isReaderTarget =
    singleActionTarget !== undefined &&
    singleActionTarget.key === openThreadKey;

  const mailCommandContext = useMemo(
    () => ({
      actions: {
        archive: archiveTargets,
        moveToInbox: targetsArchived ? moveToInboxTargets : undefined,
        forward: singleActionTarget ? requestForwardTarget : undefined,
        label: canLabel ? openLabelPicker : undefined,
        star: starTargets,
        markRead: markReadTargets,
        markSpam: markSpamTargets,
        markUnread: markUnreadTargets,
        move: canLabel ? openMovePicker : undefined,
        openExternal:
          isReaderTarget && openExternalUrl
            ? () =>
                window.open(openExternalUrl, "_blank", "noopener,noreferrer")
            : undefined,
        snooze: snoozeTargets,
        translate: isReaderTarget ? translateOpenThread : undefined,
        comment: isReaderTarget ? openTeamComments : undefined,
        trash: trashTargets,
      },
      allStarred,
      hasRead: actionTargets.some((target) => !isThreadUnread(target.messages)),
      hasUnread: actionTargets.some((target) =>
        isThreadUnread(target.messages),
      ),
      openExternalLabel:
        isReaderTarget && openExternalUrl
          ? (getOpenInMailboxLabel(readerEmailAccount?.account.provider) ??
            undefined)
          : undefined,
      target: singleActionTarget
        ? {
            emailAccountId: singleActionTarget.selection.emailAccountId,
            threadId: singleActionTarget.selection.threadId,
          }
        : undefined,
      targetCount: actionTargets.length,
    }),
    [
      archiveTargets,
      moveToInboxTargets,
      targetsArchived,
      actionTargets,
      canLabel,
      isReaderTarget,
      allStarred,
      starTargets,
      markReadTargets,
      markSpamTargets,
      markUnreadTargets,
      openLabelPicker,
      openMovePicker,
      openExternalUrl,
      readerEmailAccount?.account.provider,
      requestForwardTarget,
      singleActionTarget,
      snoozeTargets,
      translateOpenThread,
      openTeamComments,
      trashTargets,
    ],
  );

  useEffect(() => {
    setMailCommandContext(
      mailCommandContext.targetCount ? mailCommandContext : null,
    );
    return () => setMailCommandContext(null);
  }, [mailCommandContext, setMailCommandContext]);
  const isMailOverlayOpen =
    isHelpOpen ||
    isPaletteOpen ||
    Boolean(labelPicker) ||
    (isMenuOpen && Boolean(openThreadId));

  const selectAccount = useCallback(
    (accountId: string) => {
      redirectToSafeUrl(
        getMailAccountUrl(accountIds, accountId, window.location),
      );
    },
    [accountIds],
  );

  const selectAllAccounts = useCallback(() => {
    setSearchDraft(undefined);
    selection.clear();
    setFocusedIndex(0);
    setIsMenuOpen(false);
    // Only tabs every account can reproduce carry over to All Inboxes.
    const keepSplit =
      settings?.splits.some(
        (split) =>
          split.id === activeSplitId &&
          split.filters.every(
            (filter) => filter.kind === MailSplitFilterKind.UNREAD,
          ),
      ) || combinedLabelSplits.some((split) => split.id === activeSplitId);
    const slug =
      keepSplit && activeSplitId ? splitSlugs.get(activeSplitId) : undefined;
    updateLocation((current) => ({
      accountIndex: current.accountIndex,
      allInboxes: true,
      view: slug ? { kind: "split", slug } : INBOX_VIEW,
    }));
  }, [
    activeSplitId,
    settings?.splits,
    combinedLabelSplits,
    selection.clear,
    splitSlugs,
    updateLocation,
  ]);

  const openSnoozedThread = useCallback(
    (threadId: string) => setOpenThread({ emailAccountId, threadId }),
    [emailAccountId, setOpenThread],
  );

  const closeReader = useCallback(() => {
    setOpenThread(null);
  }, [setOpenThread]);

  const senderCommands =
    senderCommandContext?.emailAccountId ===
      singleActionTarget?.selection.emailAccountId &&
    senderCommandContext?.threadId === singleActionTarget?.selection.threadId
      ? senderCommandContext
      : null;
  // `useShortcuts` keeps handlers in a ref, so these need no memoization.
  const handlers: ShortcutHandlers = (() => {
    if (sidePanelThreadId || labelPicker) return {};
    return {
      unsubscribe:
        !isMailOverlayOpen && !senderCommands?.isUnsubscribeDisabled
          ? senderCommands?.unsubscribe
          : undefined,
      toggleAutoArchive:
        !isMailOverlayOpen && !senderCommands?.isAutoArchiveDisabled
          ? senderCommands?.toggleAutoArchive
          : undefined,
      next: (event) => {
        if (openThreadId && event?.key === "ArrowDown") return;
        move(1);
      },
      previous: (event) => {
        if (openThreadId && event?.key === "ArrowUp") return;
        move(-1);
      },
      open: openThreadId
        ? (event) => {
            if (
              event?.target instanceof Element &&
              event.target.closest("[data-thread-message-id]")
            )
              return;
            requestReaderReply();
          }
        : () => openAt(clampedIndex),
      backToList: isMailOverlayOpen
        ? undefined
        : () => {
            if (selection.hasSelection) selection.clear();
            else if (layout === "list" && openThreadId) closeReader();
            else if (searchValue) setSearch("");
          },
      nextSplit: () => {
        const index = splits.findIndex(
          (split) => split.id === displayedActiveSplitId,
        );
        const next = splits[(index + 1) % splits.length];
        if (next) setActiveSplitId(next.id);
      },
      switchAccount: (event) => {
        const accountNumber = Number(event?.key);
        if (
          !Number.isInteger(accountNumber) ||
          accountNumber < 1 ||
          accountNumber > 9
        )
          return;
        const account = accountsData?.emailAccounts.at(accountNumber - 1);
        if (account && (isAllAccounts || account.id !== emailAccountId)) {
          selectAccount(account.id);
        }
      },
      switchAllAccounts: selectAllAccounts,
      select: () => selection.toggle(clampedIndex),
      selectAll: selection.selectAll,
      // The cursor travels with the extension; without that, every repeat
      // re-extends from the same row and the range never grows.
      extendSelectionDown: () => extendSelection(1),
      extendSelectionUp: () => extendSelection(-1),
      label: canLabel ? openLabelPicker : undefined,
      move: canLabel ? openMovePicker : undefined,
      archive: targetsArchived ? undefined : archiveTargets,
      star: starTargets,
      markSpam: markSpamTargets,
      markUnread: markUnreadTargets,
      delete: trashTargets,
      reply: () => openReply(false),
      replyAll: () => openReply(true),
      markRead: markReadTargets,
      // The combined inbox has no per-account mailboxes to go to.
      goToInbox: isAllAccounts ? undefined : () => goToMailbox("inbox"),
      goToStarred: isAllAccounts ? undefined : () => goToMailbox("starred"),
      goToSent: isAllAccounts ? undefined : () => goToMailbox("sent"),
      goToDrafts: isAllAccounts ? undefined : () => goToMailbox("draft"),
      goToAllMail: isAllAccounts ? undefined : () => goToMailbox("all"),
      forward: singleActionTarget ? requestForwardTarget : undefined,
      moreActions: openThreadId
        ? () => setIsMenuOpen((open) => !open)
        : undefined,
      openTeamComments,
      openExternal:
        isReaderTarget && openExternalUrl
          ? () => window.open(openExternalUrl, "_blank", "noopener,noreferrer")
          : undefined,
      translate: isMailOverlayOpen ? undefined : translateOpenThread,
      undo: async () => {
        if (await undoLatestToast()) return;
        await undo();
      },
      toggleLayout: canSplit ? toggleLayout : undefined,
      togglePreview,
      help: () => setIsHelpOpen(true),
      search: isMailOverlayOpen
        ? undefined
        : () => {
            if (selection.hasSelection) selection.clear();
            if (layout === "list" && openThreadId) closeReader();
            pendingSearchFocusRef.current = true;
            const input = searchInputRef.current;
            if (input) {
              pendingSearchFocusRef.current = false;
              input.focus();
              input.select();
            }
          },
    };
  })();

  // Same destination as the sidebar row, so the view starts fresh.
  function goToMailbox(type: string) {
    router.push(
      buildMailPath({
        accountIndex: mailLocation.accountIndex,
        view: getMailNavView({ kind: "type", type }, mailSlugs),
      }),
    );
  }

  function openReply(toEveryone: boolean) {
    setForwardToMessageId(undefined);
    if (!openThreadId && focusedThread) {
      setOpenThread(getListThreadSelection(focusedThread, emailAccountId));
    }
    setReplyAll(toEveryone);
    setReplyToMessageId(composeTargetMessageId);
    focusOpenReply();
  }

  useLayoutEffect(() => {
    // The search field remounts when selection clears or the list returns, so
    // consume a pending `/` focus after whichever commit actually rendered it.
    if (!pendingSearchFocusRef.current) return;
    const input = searchInputRef.current;
    if (!input) return;
    pendingSearchFocusRef.current = false;
    input.focus();
    input.select();
  });

  useShortcuts(handlers, { isDesktopApp });

  // Senders the reader actually corresponds with, so "Describe it" can turn a
  // person's name into an address instead of guessing a domain.
  const getSplitSenders = useStableCallback(() => {
    const seen = new Set<string>();
    for (const thread of threads) {
      const from = thread.messages.at(-1)?.headers.from;
      const address = from ? extractEmailAddress(from) : null;
      if (address && address !== userEmail) seen.add(address);
      if (seen.size >= 50) break;
    }
    return [...seen];
  });

  const onMailboxItemDeleted = useCallback(
    async (item: MailboxItem) => {
      const isActive =
        item.kind === "folder"
          ? scopeFolderId === item.id
          : scopeLabelId === item.id;
      const deletedActiveSplit =
        item.kind === "label" &&
        settings?.splits?.some(
          (split) =>
            split.id === activeSplitId &&
            // Deleting the label removes a split defined solely by it.
            split.filters.length > 0 &&
            split.filters.every(
              (filter) =>
                filter.kind === MailSplitFilterKind.LABEL &&
                filter.value === item.id,
            ),
        );
      if (isActive || deletedActiveSplit) {
        setIsMenuOpen(false);
        updateLocation((current) => ({
          ...current,
          view: INBOX_VIEW,
          threadId: isActive ? null : current.threadId,
        }));
      }
      if (item.kind === "label") await mutateSettings();
    },
    [
      mutateSettings,
      activeSplitId,
      scopeFolderId,
      scopeLabelId,
      settings?.splits,
      updateLocation,
    ],
  );

  const onRemoveLabel = useStableCallback(async (labelId: string) => {
    if (!openThreadSelection || !client) return;
    try {
      const { admission } = await submitConversationChange({
        client,
        accountId: openThreadSelection.emailAccountId,
        conversationId: openThreadSelection.threadId,
        change: {
          kind: "set_membership",
          membership: "label",
          id: labelId,
          present: false,
        },
      });
      if (admission.status === "rejected") {
        toast.error(
          admissionRejectionCopy(admission.code) ?? "Couldn't remove label",
        );
      }
    } catch {
      toast.error("Couldn't remove label");
    }
  });

  const refetchReader = useStableCallback(() => {
    Promise.allSettled([refetchOpenThread(), refetchThreadList()]);
  });

  const markOpenThreadRead = useStableCallback(() => {
    if (!openThreadKey) return;
    setReadState([openThreadKey], true);
  });
  const onSendSuccess = useStableCallback(
    (_messageId: string, sentThreadId: string, repliedThreadId: string) => {
      // A held send settles after the undo window, by which time the user may
      // have moved on; only follow the reply if they are still on its thread.
      if (
        !openThreadSelection ||
        repliedThreadId !== openThreadSelection.threadId ||
        !sentThreadId.trim() ||
        sentThreadId === openThreadSelection.threadId
      )
        return;
      setReplyToMessageId(undefined);
      setOpenThread({
        emailAccountId: openThreadSelection.emailAccountId,
        threadId: sentThreadId,
      });
    },
  );
  const onToggleAssistant = useStableCallback(() =>
    toggleSidebar(["chat-sidebar"]),
  );
  const onContinueInChat = useStableCallback((question: string) => {
    setSidebarOpen((open) =>
      open.includes("chat-sidebar") ? open : [...open, "chat-sidebar"],
    );
    if (!chatId) setNewChat();
    setPendingQuestion(question);
  });
  const searchFolders = useMemo(
    () =>
      isOutlook && !isAllAccounts
        ? getMailSearchFolders(folders)
        : NO_SEARCH_OPTIONS,
    [folders, isAllAccounts, isOutlook],
  );
  const showSplitTabs = !isScoped && !searchQuery;
  const viewTitle = getMailViewTitle({
    isAllAccounts,
    searchQuery,
    scopeType,
    labelName: scopeLabelId
      ? allLabels.find((label) => label.id === scopeLabelId)?.name
      : undefined,
    folderName: scopeFolderId
      ? getMailSidebarFolders(folders).find(
          (folder) => folder.id === scopeFolderId,
        )?.displayName
      : undefined,
    labelTerm: getEmailTerminology(provider).label.singularCapitalized,
  });
  const emptyViewMessage = getEmptyViewMessage({
    viewTitle,
    isInbox: !isScoped && !searchQuery && !activeSplitId,
  });
  const threadCount = threads.length;
  const { selectedCount, selectAll, clear: clearSelection } = selection;
  // Only offered once something is selected, so the tabs sit flush otherwise.
  const selectAllCheckbox = useMemo(
    () =>
      selectedCount > 0 ? (
        <SelectAllCheckbox
          threadCount={threadCount}
          selectedCount={selectedCount}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
        />
      ) : null,
    [threadCount, selectedCount, selectAll, clearSelection],
  );

  // Views kept in our database rather than the mailbox list their own rows.
  let databaseList: ReactNode = null;
  if (isScheduledView) databaseList = <ScheduledEmailList />;
  else if (isSnoozedView)
    databaseList = <SnoozedThreadList onOpenThread={openSnoozedThread} />;

  const showList = layout === "split" || !openThreadSelection;
  const showReader = layout === "split" || Boolean(openThreadSelection);
  const readerUserLabels = isAllAccounts
    ? (labelsByAccount[openThreadSelection?.emailAccountId ?? ""] ?? NO_LABELS)
    : userLabels;

  const senderCommandsPanel =
    !isReaderTarget &&
    singleActionTarget &&
    senderAccount &&
    !sidePanelThreadId ? (
      <EmailAccountScopeProvider emailAccount={senderAccount}>
        <ListSenderCommands
          key={singleActionTarget.key}
          message={singleActionTarget.messages.at(-1) ?? null}
        />
      </EmailAccountScopeProvider>
    ) : null;

  const labelPickerDialog =
    labelPicker && pickerAccount ? (
      <EmailAccountScopeProvider emailAccount={pickerAccount}>
        <LabelPickerDialog
          threadIds={labelPicker.targets.map((target) => target.threadId)}
          mode={labelPicker.mode}
          onClose={() => setLabelPicker(null)}
          onApplied={(threadIds, _labelId) => {
            const keys = threadIds.map((threadId) =>
              isAllAccounts ? `${pickerAccount.id}:${threadId}` : threadId,
            );
            // Also refreshes the sidebar's label counts.
            client?.requestSync([pickerAccount.id]).catch(() => undefined);
            refetchOpenThread();
            refetchThreadList();
            if (labelPicker.mode === "move") {
              if (openThreadKey && keys.includes(openThreadKey)) {
                advanceReaderPast(openThreadKey, keys);
              }
              selection.clear();
            }
            mutateLabels();
          }}
        />
      </EmailAccountScopeProvider>
    ) : null;

  return (
    <MailProductFrame
      accountSwitcher={
        <MailMobileNav
          onOpenMailboxes={() => setIsMobileSidebarOpen(true)}
          readerActions={
            openThreadSelection && !isLargeScreen
              ? {
                  onBack: closeReader,
                  onArchive: targetsArchived ? undefined : archiveTargets,
                  onMoveToInbox: targetsArchived
                    ? moveToInboxTargets
                    : undefined,
                  onReply: () => openReply(false),
                  onDelete: trashTargets,
                  onMore: () => setIsMenuOpen(true),
                }
              : null
          }
          accountSwitcher={
            <MailAccountSwitcher
              isDesktopApp={isDesktopApp}
              isAllAccounts={isAllAccounts}
              onSelectAccount={selectAccount}
              onSelectAll={selectAllAccounts}
              variant="bar"
            />
          }
        />
      }
      floating={senderCommandsPanel}
      dialogs={labelPickerDialog}
    >
      <MailShellSidebar
        activeType={
          scopeLabelId || scopeFolderId ? null : (scopeType ?? "inbox")
        }
        activeLabelId={scopeLabelId}
        activeFolderId={scopeFolderId}
        isAllAccounts={isAllAccounts}
        isDesktopApp={isDesktopApp}
        onSelectAccount={selectAccount}
        onSelectAllAccounts={selectAllAccounts}
        onMailboxItemDeleted={onMailboxItemDeleted}
        mobileOpen={isMobileSidebarOpen && !isLargeScreen}
        onMobileOpenChange={setIsMobileSidebarOpen}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MailEngineConnectionBanner />
        <div className="flex min-h-0 min-w-0 flex-1">
          {showList && (
            <section
              className={
                layout === "split"
                  ? "flex min-h-0 w-[clamp(258px,32vw,400px)] shrink-0 flex-col border-r border-border"
                  : // min-w-0 matters: a flex item won't shrink below its content
                    // width without it, so long snippets would widen the column
                    // past the viewport instead of truncating.
                    "flex min-h-0 min-w-0 flex-1 flex-col"
              }
            >
              <ListToolbar
                layout={layout}
                isDesktopApp={isDesktopApp}
                searchQuery={searchParam ?? ""}
                onSearch={setSearch}
                searchValue={searchValue}
                onSearchChange={onSearchChange}
                searchInputRef={searchInputRef}
                searchLabels={isAllAccounts ? NO_SEARCH_OPTIONS : allLabels}
                searchFolders={searchFolders}
                searchVariant={getMailSearchVariant({
                  isAllAccounts,
                  isOutlook,
                })}
                onToggleLayout={toggleLayout}
                expandedPreview={expandedPreview}
                onTogglePreview={togglePreview}
                onToggleAssistant={onToggleAssistant}
                showLayoutToggle={canSplit}
                viewTitle={viewTitle}
                selectAll={showSplitTabs ? null : selectAllCheckbox}
                selectedCount={selection.selectedCount}
                onArchiveSelected={archiveTargets}
                onMoveToInboxSelected={
                  targetsArchived ? moveToInboxTargets : undefined
                }
                onDeleteSelected={trashTargets}
                isUnreadSelected={actionTargets.some((target) =>
                  isThreadUnread(target.messages),
                )}
                onMarkReadSelected={markReadTargets}
                onMarkUnreadSelected={markUnreadTargets}
                isStarredSelected={allStarred}
                onStarSelected={starTargets}
                onLabelSelected={canLabel ? openLabelPicker : undefined}
                onClearSelection={selection.clear}
              />
              {showSplitTabs && (
                <MailSplitTabs
                  leading={selectAllCheckbox}
                  splits={splitTabs}
                  activeSplitId={displayedActiveSplitId}
                  onSelectSplit={setActiveSplitId}
                  isAllAccounts={isAllAccounts}
                  getSenders={getSplitSenders}
                  countAccountIds={splitCountAccountIds}
                  portableLabelSplits={
                    isAllAccounts ? combinedLabelSplits : undefined
                  }
                  labelsByAccount={isAllAccounts ? labelsByAccount : undefined}
                />
              )}
              {showSplitTabs && !isAllAccounts && (
                <InboxStyleCard
                  ready={threads.length > 0 || (!isLoading && !isFirstSync)}
                  onDone={() => setIsTourOpen(true)}
                />
              )}
              {showSplitTabs && !isAllAccounts && <CueLabelsCard />}
              {isTourOpen && (
                <WhatsNewTour onClose={() => setIsTourOpen(false)} />
              )}
              {isAllAccounts ? (
                <AllInboxesFailedNotice
                  accounts={combinedAccounts}
                  failedAccountIds={combinedThreadState.failedAccountIds}
                />
              ) : null}
              {!isAllAccounts && accountThreadState.cueSortingUnavailable ? (
                <p
                  role="status"
                  className="px-5 pt-3 text-muted-foreground text-xs"
                >
                  Cue&apos;s sorting couldn&apos;t load, so this tab may be
                  missing mail for now. It catches up on its own.
                </p>
              ) : null}
              {allInboxesFirstSyncMessage && (threads.length || searchQuery) ? (
                <MailLoadingNote message={allInboxesFirstSyncMessage} />
              ) : null}
              {searchParam && emailAccountId ? (
                <SearchAnswerCard
                  emailAccountId={emailAccountId}
                  key={searchParam}
                  noResults={searchFoundNothing && isSearchCommitted}
                  onContinueInChat={onContinueInChat}
                  query={searchParam}
                />
              ) : null}
              <MailPanelErrorBoundary
                resetKey={JSON.stringify([
                  emailAccountId,
                  isAllAccounts,
                  query,
                  displayedActiveSplitId,
                  searchQuery,
                ])}
                title="Unable to show your mail list"
              >
                {databaseList ?? (
                  <LoadingContent
                    loading={
                      !threads.length &&
                      (isLoading ||
                        (!!searchQuery && !searchSettled) ||
                        (!searchQuery && isFirstSync))
                    }
                    loadingComponent={
                      searchQuery ? undefined : (
                        <MailListPlaceholder
                          message={listPlaceholderMessage}
                          layout={layout}
                        />
                      )
                    }
                    error={searchQuery ? undefined : error}
                  >
                    <ThreadList
                      threads={threads}
                      emptyMessage={emptySearchMessage ?? emptyViewMessage}
                      layout={layout}
                      expandedPreview={expandedPreview}
                      userEmail={userEmail}
                      userLabels={isAllAccounts ? NO_LABELS : userLabels}
                      labelsByAccount={labelsByAccount}
                      accountColorIndexById={accountColorIndexById}
                      focusedIndex={clampedIndex}
                      isSelected={selection.isSelected}
                      selectedCount={selection.selectedCount}
                      onOpenThread={openAt}
                      onToggleSelect={selection.toggle}
                      onSelectRangeTo={selection.selectRangeTo}
                      showLoadMore={hasMore}
                      isLoadingMore={isLoadingMore}
                      onLoadMore={loadMore}
                      rowActions={rowActions}
                      insightsPaused={isFirstSync}
                      showSentOpenStatus={
                        scopeType === "sent" && !isAllAccounts
                      }
                      listKey={
                        isAllAccounts
                          ? `all-accounts:${searchQuery ?? displayedActiveSplitId}`
                          : JSON.stringify(query)
                      }
                    />
                  </LoadingContent>
                )}
              </MailPanelErrorBoundary>
            </section>
          )}

          {showReader ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {showList ? null : (
                <MailTitlebarNav
                  showHistory={isDesktopApp}
                  className="px-3 pt-3"
                />
              )}
              <MailReaderPane
                readerEmailAccount={readerEmailAccount}
                readerKey={openReaderThreadKey}
                planSelection={deferredReaderSelection}
                dataReady={
                  !openThreadSelection ||
                  (readerSelectionSettled &&
                    Boolean(openThreadData || openThreadError))
                }
                onReady={setVisibleReaderThreadKey}
                onClose={closeReader}
                showFixWithChat={
                  !isAllAccounts ||
                  openThreadSelection?.emailAccountId === emailAccountId
                }
                lastMessage={openMessages.at(-1) ?? null}
                isStarred={allStarred}
                onToggleStar={starTargets}
                isImportant={allImportant}
                onToggleImportant={
                  isGoogleProvider(readerEmailAccount?.account.provider)
                    ? importantTargets
                    : undefined
                }
                onMarkSpam={markSpamTargets}
                onDelete={trashTargets}
                onLabel={canLabel ? openLabelPicker : undefined}
                onMove={canLabel ? openMovePicker : undefined}
                onTranslate={translateOpenThread}
                onComment={openTeamComments}
                onPrint={printOpenThread}
                isMenuOpen={isMenuOpen}
                onMenuOpenChange={setIsMenuOpen}
                enableMessageNavigation={!sidePanelThreadId}
                thread={openThread ?? null}
                threadId={openThreadId}
                detailSelectionSettled={readerSelectionSettled}
                loading={
                  Boolean(openThreadSelection) &&
                  (!readerSelectionSettled || isOpenThreadLoading)
                }
                error={readerSelectionSettled ? openThreadError : undefined}
                messages={openMessages}
                localAvailability={
                  readerSelectionSettled
                    ? openThreadLocalAvailability
                    : undefined
                }
                userLabels={readerUserLabels}
                layout={layout}
                labelHref={labelHref}
                onRemoveLabel={onRemoveLabel}
                onArchive={archiveTargets}
                onMoveToInbox={targetsArchived ? moveToInboxTargets : undefined}
                onRestore={targetsTrashed ? restoreTargets : undefined}
                onNotSpam={targetsSpam ? notSpamTargets : undefined}
                onSnooze={
                  targetsTrashed || targetsSpam ? undefined : snoozeTargets
                }
                isUnread={isOpenThreadUnread}
                onMarkRead={markOpenThreadRead}
                onMarkUnread={markUnreadTargets}
                refetch={refetchReader}
                onSendSuccess={onSendSuccess}
                autoOpenReplyForMessageId={replyToMessageId}
                autoOpenReplyAll={replyAll}
                autoOpenForwardForMessageId={forwardToMessageId}
              />
            </div>
          ) : null}
        </div>
      </div>
    </MailProductFrame>
  );
}

function getMailSearchVariant({
  isAllAccounts,
  isOutlook,
}: {
  isAllAccounts: boolean;
  isOutlook: boolean;
}): "gmail" | "outlook" | "common" {
  if (isAllAccounts) return "common";
  if (isOutlook) return "outlook";
  return "gmail";
}

function useStableOrderedIds(threads: ListThread[]) {
  const previous = useRef<string[]>([]);
  // Selection callbacks close over the ids; keeping them while the order is
  // unchanged means a snapshot that edits one row doesn't re-render every row.
  return useMemo(() => {
    const ids = threads.map(getListThreadKey);
    const unchanged =
      ids.length === previous.current.length &&
      ids.every((id, index) => id === previous.current[index]);
    if (!unchanged) previous.current = ids;
    return previous.current;
  }, [threads]);
}

/** Names any view but the inbox, so a phone without a sidebar says where it is. */
function getMailViewTitle({
  isAllAccounts,
  searchQuery,
  scopeType,
  labelName,
  folderName,
  labelTerm,
}: {
  isAllAccounts: boolean;
  searchQuery: string | null;
  scopeType: string | null;
  labelName: string | undefined;
  folderName: string | undefined;
  labelTerm: string;
}): string | null {
  if (searchQuery) return "Search results";
  if (isAllAccounts) return null;
  if (labelName) return `${labelTerm}: ${labelName}`;
  if (folderName) return folderName;
  if (scopeType && scopeType !== "inbox")
    return getMailboxName(scopeType) ?? null;
  return null;
}

function getEmptyViewMessage({
  viewTitle,
  isInbox,
}: {
  viewTitle: string | null;
  isInbox: boolean;
}) {
  // An empty inbox is the goal, not a gap.
  if (isInbox) return "You're all caught up.";
  if (viewTitle) return `Nothing in ${viewTitle}.`;
  return "Nothing here right now.";
}

const EMPTY_SEARCH_THREADS: ListThread[] = [];
const NO_SEARCH_OPTIONS: { name: string }[] = [];

// A reply already open, such as a saved draft, didn't take focus when it
// appeared. A new one focuses itself as it mounts.
function focusOpenReply() {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        '[data-testid="thread-reader"] [data-email-editor-content]',
      )
      ?.focus();
  });
}
