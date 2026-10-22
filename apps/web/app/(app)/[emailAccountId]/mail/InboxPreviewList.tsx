"use client";

import {
  Component,
  createContext,
  type MouseEvent,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { z } from "zod";
import type { MessageKey } from "@inboxzero/mail-core/identities";
import { providerChangeSchema } from "@inboxzero/mail-core/sync";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { InboxPreview as LoadedInboxPreview } from "@/utils/threads/inbox-preview.server";
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
import { isGoogleProvider } from "@/utils/email/provider-types";
import { fetchWithAccount } from "@/utils/fetch";
import { isLocalMailboxStale } from "@/utils/mail-engine/local-mailbox-cookie";
import { followWakeCatchUp } from "@/utils/mail-engine/wake-catch-up";
import { buildMailPath, parseMailPath, withPageParams } from "@/utils/mail-url";
import type { GetInboxCatchUpResponse } from "@/app/api/user/inbox-catch-up/route";

const NO_SELECTION = () => false;
const IGNORE = () => undefined;
// Enough of a clicked conversation to read it; at about five Gmail units a
// message, a long thread's earlier messages wait for the sync.
const OPENED_MESSAGES = 10;

type InboxPreview = LoadedInboxPreview | null;
type Seed = {
  emailAccountId: string;
  preview: Promise<InboxPreview>;
  /** For a local mailbox that has fallen behind, rather than none. */
  catchUp: boolean;
};
const previewChangesSchema = z.array(providerChangeSchema);
// Each page's rows are handed to the engine once, however often it renders.
const ingestedPreviews = new WeakSet<Promise<InboxPreview>>();

const InboxPreviewSeedContext = createContext<{
  seed: Seed | null;
  serverClockOffsetMs: number;
  retired: boolean;
  retire: () => void;
  opened: MessageKey[];
  open: (keys: MessageKey[]) => void;
  settleOpened: (keys: MessageKey[]) => void;
}>({
  seed: null,
  serverClockOffsetMs: 0,
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
  catchUp = false,
  serverNowMs,
  children,
}: {
  emailAccountId: string;
  preview: Promise<InboxPreview> | null;
  catchUp?: boolean;
  /** The server's clock as it rendered the page. */
  serverNowMs?: number;
  children: ReactNode;
}) {
  // Read as the page first renders here; a stream that took a few seconds
  // only makes the browser's recorded times that much older.
  const [serverClockOffsetMs] = useState(() =>
    serverNowMs === undefined ? 0 : serverNowMs - Date.now(),
  );
  const [seed, setSeed] = useState<Seed | null>(() =>
    preview ? { emailAccountId, preview, catchUp } : null,
  );
  if (
    preview &&
    (seed?.preview !== preview || seed.emailAccountId !== emailAccountId)
  ) {
    setSeed({ emailAccountId, preview, catchUp });
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
    () => ({
      seed,
      serverClockOffsetMs,
      retired,
      retire,
      opened,
      open,
      settleOpened,
    }),
    [seed, serverClockOffsetMs, retired, retire, opened, open, settleOpened],
  );
  return (
    <InboxPreviewSeedContext.Provider value={value}>
      {children}
    </InboxPreviewSeedContext.Provider>
  );
}

/**
 * How far the server's clock is ahead of this browser's, so a time the
 * browser records for the server to compare (the local mailbox's last sync)
 * is on the server's clock, whatever this browser's clock says.
 */
export function useServerClockOffset() {
  return useContext(InboxPreviewSeedContext).serverClockOffsetMs;
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
 * Hands the messages behind the server's rows to the mail engine as soon as
 * it runs, so the inbox shows them from the engine, where they open and
 * triage like any other row, rather than after its first sync reads them
 * again. The engine only adds messages it doesn't have, so nothing it holds,
 * such as a message just archived, changes. After a sign-in nothing is
 * handed over once the engine has shown this account's mail; for a mailbox
 * that has fallen behind, which shows its own mail at once, the newest mail
 * is handed over whenever it arrives, ahead of the catch-up.
 */
export function useIngestInboxPreview() {
  const { emailAccountId } = useAccount();
  const { seed, retired } = useContext(InboxPreviewSeedContext);
  const client = useOptionalMailClient();
  useEffect(() => {
    if (
      !client?.ingestMessages ||
      !seed ||
      (retired && !seed.catchUp) ||
      seed.emailAccountId !== emailAccountId ||
      ingestedPreviews.has(seed.preview)
    )
      return;
    // The rows can arrive seconds later, after the engine has shown mail;
    // retiring them, or any other change here, ends this wait.
    let waiting = true;
    // A promise streamed from the server is a thenable whose then() returns
    // nothing, so it is wrapped before chaining.
    Promise.resolve(seed.preview)
      .then((preview) => {
        if (!waiting || ingestedPreviews.has(seed.preview)) return;
        const changes = previewChangesSchema.safeParse(preview?.changes);
        if (!changes.success || !changes.data.length) return;
        ingestedPreviews.add(seed.preview);
        return client.ingestMessages?.({
          accountId: seed.emailAccountId,
          changes: changes.data,
        });
      })
      .catch(IGNORE);
    return () => {
      waiting = false;
    };
  }, [client, seed, retired, emailAccountId]);
}

/**
 * The same catch-up a page load gets for a mailbox that fell behind (RL-1),
 * for a tab shown again after a long absence, or woken from a long sleep with
 * it showing, without reloading: the newest
 * inbox mail is read once, at interactive priority, and handed to the engine
 * ahead of its own catch-up. Only the open account's; the others follow their
 * usual sync. Gmail only, as the server's preview hands Outlook's engine
 * nothing.
 */
export function useCatchUpOnWake({
  lastSyncedAtMs,
  enabled,
}: {
  /** When the open account's local mailbox last finished a sync. */
  lastSyncedAtMs: number | null;
  enabled: boolean;
}) {
  const { emailAccountId, provider } = useAccount();
  const client = useOptionalMailClient();
  // A ref, not a dependency: the listener must outlive each sync's new time,
  // or every finished sync would restart it and forget the absence. Read when
  // the wake settles, so a catch-up that finished since counts.
  const lastSynced = useRef(lastSyncedAtMs);
  useEffect(() => {
    lastSynced.current = lastSyncedAtMs;
  }, [lastSyncedAtMs]);
  useEffect(() => {
    if (
      !enabled ||
      !emailAccountId ||
      !client?.ingestMessages ||
      !isGoogleProvider(provider)
    )
      return;
    return followWakeCatchUp({
      accountId: emailAccountId,
      isStale: () =>
        lastSynced.current != null && isLocalMailboxStale(lastSynced.current),
      onWake: async (signal) => {
        const response = await fetchWithAccount({
          url: "/api/user/inbox-catch-up",
          emailAccountId,
          init: { signal },
        });
        if (!response.ok || signal.aborted) return;
        const body: GetInboxCatchUpResponse = await response.json();
        const changes = previewChangesSchema.safeParse(body.changes);
        if (!changes.success || !changes.data.length || signal.aborted) return;
        await client.ingestMessages?.({
          accountId: emailAccountId,
          changes: changes.data,
        });
      },
    });
  }, [enabled, emailAccountId, provider, client]);
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
  splitId,
}: {
  message: string;
  layout?: MailLayoutMode;
  withChrome?: boolean;
  /** Defaults to whether the address is the account's inbox. */
  enabled?: boolean;
  /**
   * The tab the list shows, or null for the whole inbox; the rows show only
   * for the one they were read for. Left out, they show for whatever the
   * inbox address opens on, which is what the server read them for.
   */
  splitId?: string | null;
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
  // Only ever the open account's mail. A mailbox that fell behind has mail
  // of its own to show, and the engine shows the newest from there.
  if (
    !isInbox ||
    retired ||
    seed?.emailAccountId !== emailAccountId ||
    seed.catchUp
  ) {
    return placeholder;
  }
  return (
    <PreviewErrorBoundary fallback={placeholder}>
      <Suspense fallback={placeholder}>
        <SeededPreviewRows
          preview={seed.preview}
          splitId={splitId}
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
  splitId,
  placeholder,
  ...props
}: {
  preview: Promise<InboxPreview>;
  splitId: string | null | undefined;
  placeholder: ReactNode;
  message: string;
  layout: MailLayoutMode;
  withChrome: boolean;
}) {
  const data = use(preview);
  if (!data?.threads.length) return placeholder;
  if (splitId !== undefined && data.splitId !== splitId) return placeholder;
  return <PreviewRows preview={data} {...props} />;
}

function PreviewRows({
  preview,
  message,
  layout,
  withChrome,
}: {
  preview: LoadedInboxPreview;
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
