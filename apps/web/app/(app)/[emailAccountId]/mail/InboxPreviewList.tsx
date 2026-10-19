"use client";

import {
  Component,
  createContext,
  type MouseEvent,
  type ReactNode,
  Suspense,
  startTransition,
  use,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import type { MessageKey } from "@inboxzero/mail-core/identities";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import {
  MailListPlaceholder,
  MailLoadingNote,
  PlaceholderChrome,
} from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { showMailView } from "@/app/(app)/[emailAccountId]/mail/show-mail-view";
import { ThreadList } from "@/app/(app)/[emailAccountId]/mail/ThreadList";
import type {
  ListThread,
  MailLayoutMode,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { readInboxSnapshot } from "@/utils/mail-engine/inbox-snapshot";
import { useEmailLabels } from "@/providers/EmailLabelsProvider";
import { useAccount } from "@/providers/EmailAccountProvider";
import { buildMailPath, parseMailPath, withPageParams } from "@/utils/mail-url";

const NO_SELECTION = () => false;
const IGNORE = () => undefined;
// Enough of a clicked conversation to read it; at about five Gmail units a
// message, a long thread's earlier messages wait for the sync.
const OPENED_MESSAGES = 10;

type InboxPreview = ThreadsListResponse | null;
type Seed = { emailAccountId: string; preview: Promise<InboxPreview> };

const InboxPreviewSeedContext = createContext<{
  seed: Seed | null;
  retired: boolean;
  retire: () => void;
  opened: MessageKey[];
  open: (keys: MessageKey[]) => void;
  settleOpened: (keys: MessageKey[]) => void;
}>({
  seed: null,
  retired: false,
  retire: IGNORE,
  opened: [],
  open: IGNORE,
  settleOpened: IGNORE,
});

/**
 * The inbox the server began fetching while it rendered the page, for a
 * browser with no local mailbox yet; the rows stream in with the page. Always
 * rendered, so the mail screen keeps its place in the tree, and it keeps the
 * last seed when a later render, such as after a server action, carries none.
 */
export function InboxPreviewSeed({
  emailAccountId,
  preview,
  children,
}: {
  emailAccountId: string;
  preview: Promise<InboxPreview> | null;
  children: ReactNode;
}) {
  const [seed, setSeed] = useState<Seed | null>(() =>
    preview ? { emailAccountId, preview } : null,
  );
  if (
    preview &&
    (seed?.preview !== preview || seed.emailAccountId !== emailAccountId)
  ) {
    setSeed({ emailAccountId, preview });
  }
  const [retired, setRetired] = useState(false);
  const retire = useCallback(() => setRetired(true), []);
  const [opened, setOpened] = useState<MessageKey[]>([]);
  const open = useCallback(
    (keys: MessageKey[]) => setOpened((current) => [...current, ...keys]),
    [],
  );
  const settleOpened = useCallback(
    (keys: MessageKey[]) =>
      setOpened((current) => current.filter((key) => !keys.includes(key))),
    [],
  );
  const value = useMemo(
    () => ({ seed, retired, retire, opened, open, settleOpened }),
    [seed, retired, retire, opened, open, settleOpened],
  );
  return (
    <InboxPreviewSeedContext.Provider value={value}>
      {children}
    </InboxPreviewSeedContext.Provider>
  );
}

/**
 * Puts the server's rows away for good once the mail engine has shown this
 * account's mail, so rows from sign-in time never come back later.
 */
export function useRetireInboxPreview() {
  return useContext(InboxPreviewSeedContext).retire;
}

/**
 * Has the mail engine fetch each conversation opened from the server's rows,
 * once it is running. The rows can reach back further than the engine's first
 * sync, which leaves older inbox mail to the backfill, so without this such a
 * conversation would open empty until the backfill got to it.
 */
export function useFetchOpenedPreviewThreads() {
  const { opened, settleOpened } = useContext(InboxPreviewSeedContext);
  const client = useOptionalMailClient();
  useEffect(() => {
    if (!client || opened.length === 0) return;
    for (const key of opened) {
      client.ensureMessageContent(key).catch(IGNORE);
    }
    settleOpened(opened);
  }, [client, opened, settleOpened]);
}

/**
 * Stands in for the inbox while the local mailbox opens or first syncs,
 * showing the newest conversations the server fetched with the page, so the
 * inbox reads at once rather than after the engine has booted and synced.
 * A browser that already holds the mailbox shows the top of the inbox as it
 * last saw it instead, while the engine opens. Without either, or elsewhere,
 * or with `enabled` off, it is the usual skeleton and asks the provider for
 * nothing.
 */
export function InboxPreviewList({
  message,
  layout = "list",
  withChrome = false,
  enabled,
}: {
  message: string;
  layout?: MailLayoutMode;
  withChrome?: boolean;
  /** Defaults to whether the address is the account's inbox. */
  enabled?: boolean;
}) {
  const { emailAccountId } = useAccount();
  const pathname = usePathname();
  const { seed, retired } = useContext(InboxPreviewSeedContext);
  const isInbox =
    enabled ?? parseMailPath(pathname ?? "")?.view?.kind === "inbox";
  const seeded = seed?.emailAccountId === emailAccountId;
  const wantsSnapshot = isInbox && !retired && !seeded;
  const [saved, setSaved] = useState<{
    accountId: string;
    threads: ListThread[];
  } | null>(null);
  // Browser storage is not there for the server render or hydration. The
  // rows render in a transition, which yields to the mail engine starting
  // beside them instead of holding up its first list.
  useEffect(() => {
    if (!wantsSnapshot) return;
    const threads = readInboxSnapshot(emailAccountId);
    if (threads)
      startTransition(() => setSaved({ accountId: emailAccountId, threads }));
  }, [wantsSnapshot, emailAccountId]);
  const snapshot =
    wantsSnapshot && saved?.accountId === emailAccountId ? saved.threads : null;
  const placeholder = (
    <MailListPlaceholder
      message={message}
      layout={layout}
      withChrome={withChrome}
    />
  );
  if (snapshot) {
    return (
      <PreviewRows
        threads={snapshot}
        fetchOpened={false}
        message={message}
        layout={layout}
        withChrome={withChrome}
      />
    );
  }
  // Only ever the open account's mail.
  if (!isInbox || retired || !seeded) {
    return placeholder;
  }
  return (
    <PreviewErrorBoundary fallback={placeholder}>
      <Suspense fallback={placeholder}>
        <SeededPreviewRows
          preview={seed.preview}
          placeholder={placeholder}
          message={message}
          layout={layout}
          withChrome={withChrome}
        />
      </Suspense>
    </PreviewErrorBoundary>
  );
}

function SeededPreviewRows({
  preview,
  placeholder,
  ...props
}: {
  preview: Promise<InboxPreview>;
  placeholder: ReactNode;
  message: string;
  layout: MailLayoutMode;
  withChrome: boolean;
}) {
  const data = use(preview);
  if (!data?.threads.length) return placeholder;
  return <PreviewRows threads={data.threads} fetchOpened {...props} />;
}

function PreviewRows({
  threads,
  fetchOpened,
  message,
  layout,
  withChrome,
}: {
  threads: ListThread[];
  /**
   * The server's rows can reach back further than the engine's first sync,
   * so a clicked one is fetched; a saved row is already in the local mailbox.
   */
  fetchOpened: boolean;
  message: string;
  layout: MailLayoutMode;
  withChrome: boolean;
}) {
  const { emailAccountId, userEmail } = useAccount();
  const { userLabels } = useEmailLabels();
  const { open } = useContext(InboxPreviewSeedContext);
  const openThread = (index: number) => {
    const thread = threads[index];
    if (!thread) return;
    if (fetchOpened) {
      open(
        thread.messages.slice(-OPENED_MESSAGES).map((message) => ({
          accountId: emailAccountId,
          messageId: message.id,
        })),
      );
    }
    openInAddress(thread.id);
  };
  return (
    <div
      aria-busy="true"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-mail-inbox-preview
    >
      {withChrome ? <PlaceholderChrome /> : null}
      <MailLoadingNote message={message} />
      {/* A placeholder, not the list: nothing selects, focuses or triages
          these rows, and assistive tech hears only the loading note. A
          click still opens the conversation, once the engine is ready. */}
      <div
        aria-hidden
        className="flex min-h-0 flex-1 flex-col"
        onMouseDown={keepFocus}
      >
        <ThreadList
          threads={threads}
          layout={layout}
          expandedPreview={false}
          userEmail={userEmail}
          userLabels={userLabels}
          selectionEnabled={false}
          focusedIndex={-1}
          isSelected={NO_SELECTION}
          selectedCount={0}
          onOpenThread={openThread}
          onToggleSelect={IGNORE}
          onSelectRangeTo={IGNORE}
          showLoadMore={false}
          isLoadingMore={false}
          onLoadMore={IGNORE}
          listKey={`inbox-preview:${emailAccountId}`}
          insightsPaused
        />
      </div>
    </div>
  );
}

// A row that took focus would look like the list's focused row.
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

/** A seed that failed to arrive shows the skeleton instead of breaking mail. */
class PreviewErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Puts a conversation clicked here in the address, from which the mail screen
 * opens it as soon as the engine is ready, so an early click is never lost.
 */
function openInAddress(threadId: string) {
  const current = parseMailPath(
    window.location.pathname,
    window.location.search,
  );
  if (!current) return;
  showMailView(
    withPageParams(
      buildMailPath({ ...current, threadId }),
      window.location.search,
    ),
  );
}
