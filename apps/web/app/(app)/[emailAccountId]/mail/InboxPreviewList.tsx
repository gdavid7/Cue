"use client";

import {
  createContext,
  type ReactNode,
  Suspense,
  use,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { usePathname } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import {
  MailListPlaceholder,
  MailLoadingNote,
  PlaceholderChrome,
} from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { ThreadList } from "@/app/(app)/[emailAccountId]/mail/ThreadList";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import { useEmailLabels } from "@/providers/EmailLabelsProvider";
import { useAccount } from "@/providers/EmailAccountProvider";
import { parseMailPath } from "@/utils/mail-url";
import { getAccountScopedKey } from "@/utils/swr";

const PREVIEW_PATH = "/api/threads?view=list&type=inbox&limit=25";
const NO_SELECTION = () => false;
const IGNORE = () => undefined;

type InboxPreview = ThreadsListResponse | null;

const InboxPreviewSeedContext = createContext<{
  emailAccountId: string;
  preview: Promise<InboxPreview>;
} | null>(null);

/**
 * The inbox the server began fetching while it rendered the page, for a
 * browser with no local mailbox yet. Rows stream in with the page itself.
 */
export function InboxPreviewSeed({
  emailAccountId,
  preview,
  children,
}: {
  emailAccountId: string;
  preview: Promise<InboxPreview>;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ emailAccountId, preview }),
    [emailAccountId, preview],
  );
  const { mutate } = useSWRConfig();
  // A later render without the seed, such as after a server action, reads the
  // rows from the browser's cache instead of asking again.
  useEffect(() => {
    let current = true;
    preview
      .then((data) => {
        if (current && data)
          mutate(getAccountScopedKey(PREVIEW_PATH, emailAccountId), data, {
            revalidate: false,
          });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [emailAccountId, mutate, preview]);
  return (
    <InboxPreviewSeedContext.Provider value={value}>
      {children}
    </InboxPreviewSeedContext.Provider>
  );
}

/**
 * Stands in for the inbox while the local mailbox opens or first syncs. The
 * newest conversations come from the server, started with the page when it
 * could be or fetched once here otherwise, so the inbox reads at once rather
 * than after the engine has booted and synced. The engine's own list replaces
 * this as soon as it has rows; until then the rows are read-only. Elsewhere,
 * or with `enabled` off, it is the usual skeleton.
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
  const isInbox =
    enabled ?? parseMailPath(pathname ?? "")?.view?.kind === "inbox";
  const seed = useContext(InboxPreviewSeedContext);
  // Only ever the open account's mail.
  const seeded =
    isInbox && seed?.emailAccountId === emailAccountId ? seed.preview : null;
  const { data } = useSWR<ThreadsListResponse>(
    isInbox && !seeded
      ? getAccountScopedKey(PREVIEW_PATH, emailAccountId)
      : null,
    { revalidateOnFocus: false, revalidateIfStale: false },
  );
  const placeholder = (
    <MailListPlaceholder
      message={message}
      layout={layout}
      withChrome={withChrome}
    />
  );

  if (seeded) {
    return (
      <Suspense fallback={placeholder}>
        <SeededPreviewRows
          preview={seeded}
          placeholder={placeholder}
          message={message}
          layout={layout}
          withChrome={withChrome}
        />
      </Suspense>
    );
  }
  if (!data?.threads.length) return placeholder;
  return (
    <PreviewRows
      preview={data}
      message={message}
      layout={layout}
      withChrome={withChrome}
    />
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
  return (
    // Rows open once the mail engine has them; until then they only show.
    <div
      aria-disabled="true"
      className="flex min-h-0 flex-1 cursor-default flex-col overflow-hidden"
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
        onOpenThread={IGNORE}
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
