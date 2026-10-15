"use client";

import {
  Component,
  createContext,
  type ReactNode,
  Suspense,
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
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
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
 * Without them, as on every warm open, or elsewhere, or with `enabled` off, it
 * is the usual skeleton and asks the provider for nothing.
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
  const placeholder = (
    <MailListPlaceholder
      message={message}
      layout={layout}
      withChrome={withChrome}
    />
  );
  // Only ever the open account's mail.
  if (!isInbox || retired || seed?.emailAccountId !== emailAccountId) {
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
  return <PreviewRows preview={data} {...props} />;
}

function PreviewRows({
  preview,
  message,
  layout,
  withChrome,
}: {
  preview: ThreadsListResponse;
  message: string;
  layout: MailLayoutMode;
  withChrome: boolean;
}) {
  const { emailAccountId, userEmail } = useAccount();
  const { userLabels } = useEmailLabels();
  const { open } = useContext(InboxPreviewSeedContext);
  const openThread = (index: number) => {
    const thread = preview.threads[index];
    if (!thread) return;
    open(
      thread.messages.slice(-OPENED_MESSAGES).map((message) => ({
        accountId: emailAccountId,
        messageId: message.id,
      })),
    );
    openInAddress(thread.id);
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-mail-inbox-preview
    >
      {withChrome ? <PlaceholderChrome /> : null}
      <MailLoadingNote message={message} />
      <ThreadList
        threads={preview.threads}
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
  );
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
