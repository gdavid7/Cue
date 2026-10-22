"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronsUpDownIcon,
  DownloadIcon,
  MessageSquareTextIcon,
  PaperclipIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type {
  FileEntry,
  FileKind,
  FileSender,
  FilesPage,
  FilesQuery,
} from "@inboxzero/mail-core/queries";
import { AccountRowMarker } from "@/app/(app)/[emailAccountId]/mail/all-accounts-list";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AttachmentPreviewDialogContent } from "@/components/email-list/EmailAttachments";
import { LoadingContent } from "@/components/LoadingContent";
import {
  FILE_KIND_FILTERS,
  FILE_KIND_ICON_COLORS,
  FILE_KIND_ICONS,
  fileAttachmentUrl,
  fileKey,
  formatFileSize,
} from "@/components/mail-files";
import { toastError } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useInboxUnreadCount } from "@/hooks/useInboxUnreadCount";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { fetchAttachment, saveBlob } from "@/utils/attachments/download";
import { formatShortDate } from "@/utils/date";
import { extractNameFromEmail } from "@/utils/email";

const PAGE_SIZE = 100;
const ROW_HEIGHT = 60;

/**
 * Every attachment on the mail stored on this device, newest first, read
 * from the local mailbox alone: listing never asks the provider or the
 * server. In All inboxes it lists every included account's, each row naming
 * its account.
 */
export function FilesView({
  accounts,
  onOpenThread,
}: {
  /** All inboxes: the accounts to list files from. */
  accounts?: AllInboxesAccount[];
  onOpenThread: (threadId: string, emailAccountId: string) => void;
}) {
  const { emailAccountId } = useAccount();
  const client = useOptionalMailClient();
  const accountIds = useMemo(
    () => (accounts ? accounts.map((account) => account.id) : [emailAccountId]),
    [accounts, emailAccountId],
  );
  const [kind, setKind] = useState<FileKind | null>(null);
  const [sender, setSender] = useState<FileSender | null>(null);
  const [name, setName] = useState("");
  const deferredName = useDeferredValue(name.trim());
  const [previewing, setPreviewing] = useState<FileEntry>();
  const [downloading, setDownloading] = useState<string | null>(null);

  const readFiles = client?.queryFiles?.bind(client);
  const readSenders = client?.queryFileSenders?.bind(client);
  const filters = JSON.stringify({
    accountIds,
    kind,
    sender: sender?.email ?? null,
    name: deferredName || null,
  });
  const pages = useSWRInfinite(
    (index, previous: FilesPage | null) => {
      if (!readFiles || (previous && !previous.nextPage)) return null;
      return [
        "mail-files",
        filters,
        index === 0 ? null : (previous?.nextPage ?? null),
      ];
    },
    ([, key, after]: [string, string, string | null]) => {
      if (!readFiles) throw new Error("Files can't be read here");
      return readFiles({
        ...(JSON.parse(key) as Omit<FilesQuery, "pageSize" | "after">),
        pageSize: PAGE_SIZE,
        after,
      });
    },
    { keepPreviousData: true, revalidateFirstPage: false },
  );

  const senders = useSWR(
    readSenders ? ["mail-file-senders", JSON.stringify(accountIds)] : null,
    () => readSenders?.(accountIds) ?? [],
  );
  const readNotOnDevice = client?.queryFilesNotOnDevice?.bind(client);
  const notOnDevice = useSWR(
    readNotOnDevice
      ? ["mail-files-not-on-device", JSON.stringify(accountIds)]
      : null,
    () => readNotOnDevice?.(accountIds) ?? 0,
    // An older build's owner tab answers "unsupported method"; retrying can't fix that.
    { shouldRetryOnError: false },
  );
  // All are read once; new mail reaching the inbox moves its unread count,
  // which is already watched cheaply, so that refreshes them.
  const inboxUnread = useInboxUnreadCount(accountIds);
  const { mutate } = pages;
  const { mutate: mutateSenders } = senders;
  const { mutate: mutateNotOnDevice } = notOnDevice;
  const refreshedAtUnread = useRef(inboxUnread);
  useEffect(() => {
    if (refreshedAtUnread.current === inboxUnread) return;
    refreshedAtUnread.current = inboxUnread;
    // No cheaper signal exists for bodies being stored, so the count refreshes
    // with the list on new mail and otherwise only when the view opens.
    mutate().catch(() => undefined);
    mutateSenders().catch(() => undefined);
    mutateNotOnDevice().catch(() => undefined);
  }, [inboxUnread, mutate, mutateSenders, mutateNotOnDevice]);

  const files = useMemo(
    () => pages.data?.flatMap((page) => page.files) ?? [],
    [pages.data],
  );
  const hasMore = Boolean(pages.data?.at(-1)?.nextPage);
  const loadingMore =
    pages.isValidating && pages.size > (pages.data?.length ?? 0);
  const filtered = Boolean(kind || sender || deferredName);
  // The count covers all files, so a filtered list would misstate it.
  const olderMessages = filtered ? 0 : (notOnDevice.data ?? 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // Rows render on the first frame, before the list has been measured.
    initialRect: { width: 400, height: 900 },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVisible = virtualRows.at(-1)?.index ?? -1;
  const { setSize } = pages;
  useEffect(() => {
    if (hasMore && !loadingMore && lastVisible >= files.length - 20)
      setSize((size) => size + 1);
  }, [hasMore, loadingMore, lastVisible, files.length, setSize]);

  const download = async (file: FileEntry) => {
    const id = fileKey(file);
    setDownloading(id);
    try {
      const blob = await fetchAttachment({
        url: fileAttachmentUrl(file),
        emailAccountId: file.accountId,
      });
      saveBlob(blob, file.attachment.filename);
    } catch {
      toastError({ description: "Failed to download attachment" });
    } finally {
      setDownloading(null);
    }
  };

  // A page can find nothing in the mail it read and still have older mail
  // to read, so the list keeps going before it says there is nothing.
  const emptyState = hasMore ? (
    <p
      className="px-6 py-12 text-center text-muted-foreground text-sm"
      role="status"
    >
      Looking through older mail…
    </p>
  ) : (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-muted-foreground text-sm">
      <PaperclipIcon aria-hidden="true" className="size-6" />
      {filtered ? (
        <>
          <p>No files match these filters.</p>
          <Button
            onClick={() => {
              setKind(null);
              setSender(null);
              setName("");
            }}
            size="sm"
            variant="outline"
          >
            Clear filters
          </Button>
        </>
      ) : (
        <p>
          No files yet. Attachments on your mail show up here once it&apos;s on
          this device.
        </p>
      )}
    </div>
  );

  if (!client || !readFiles)
    return (
      <p className="px-6 py-12 text-center text-muted-foreground text-sm">
        Files are listed from the mail on this device, which isn&apos;t
        available in this window. Reload to try again.
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-view">
      <div className="flex shrink-0 flex-col gap-2 border-border border-b px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden="true"
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Search file names"
              className="h-8 pr-8 pl-8 text-sm"
              onChange={(event) => setName(event.target.value)}
              placeholder="Search file names"
              type="search"
              value={name}
            />
          </div>
          <SenderFilter
            onChange={setSender}
            onOpen={() => {
              mutateSenders().catch(() => undefined);
            }}
            selected={sender}
            senders={senders.data ?? []}
          />
        </div>
        <div
          aria-label="File type"
          className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 scrollbar-none"
          role="group"
        >
          {FILE_KIND_FILTERS.map((filter) => (
            <button
              aria-pressed={kind === filter.kind}
              className={cn(
                "h-7 shrink-0 rounded-full border px-3 text-xs transition-colors active:scale-[0.97] motion-reduce:active:scale-100",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                kind === filter.kind
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-foreground hover:bg-muted",
              )}
              key={filter.label}
              onClick={() => setKind(filter.kind)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        ref={scrollRef}
      >
        <LoadingContent
          error={pages.error}
          loading={!pages.data && pages.isLoading}
        >
          {files.length === 0 ? (
            emptyState
          ) : (
            <ul
              aria-label="Files"
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualRows.map((row) => {
                const file = files[row.index];
                return (
                  <FileRow
                    accounts={accounts}
                    downloading={downloading === fileKey(file)}
                    file={file}
                    key={fileKey(file)}
                    onDownload={() => download(file)}
                    onOpenThread={() =>
                      onOpenThread(file.conversationId, file.accountId)
                    }
                    onPreview={() => setPreviewing(file)}
                    start={row.start}
                  />
                );
              })}
            </ul>
          )}
          {loadingMore && files.length > 0 ? (
            <p className="py-3 text-center text-muted-foreground text-xs">
              Loading more files…
            </p>
          ) : null}
        </LoadingContent>
      </div>
      <p
        className={cn(
          "shrink-0 text-muted-foreground text-xs",
          olderMessages > 0 && "border-border border-t px-4 py-2",
        )}
        role="status"
      >
        {olderMessages === 1 &&
          "1 older message with an attachment isn't on this device yet"}
        {olderMessages > 1 &&
          `${olderMessages} older messages with attachments aren't on this device yet`}
      </p>
      <Dialog
        onOpenChange={(open) => !open && setPreviewing(undefined)}
        open={Boolean(previewing)}
      >
        {previewing ? (
          <AttachmentPreviewDialogContent
            emailAccountId={previewing.accountId}
            filename={previewing.attachment.filename}
            key={fileKey(previewing)}
            mimeType={previewing.attachment.mimeType}
            size={previewing.attachment.size}
            url={fileAttachmentUrl(previewing)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function FileRow({
  accounts,
  file,
  start,
  downloading,
  onPreview,
  onOpenThread,
  onDownload,
}: {
  accounts: AllInboxesAccount[] | undefined;
  file: FileEntry;
  start: number;
  downloading: boolean;
  onPreview: () => void;
  onOpenThread: () => void;
  onDownload: () => void;
}) {
  const Icon = FILE_KIND_ICONS[file.kind];
  const { filename } = file.attachment;
  const sender = extractNameFromEmail(file.from) || file.from;
  return (
    <li
      className="absolute inset-x-0 top-0 flex items-center gap-1 border-border border-b pr-2 transition-colors hover:bg-muted/50 has-[button:active]:bg-muted"
      style={{ height: ROW_HEIGHT, transform: `translateY(${start}px)` }}
    >
      {accounts ? (
        <span className="shrink-0 pl-3">
          <AccountRowMarker accountId={file.accountId} accounts={accounts} />
        </span>
      ) : null}
      <button
        aria-label={`Preview ${filename}`}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-3 text-left",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          accounts ? "pl-2" : "pl-4",
        )}
        onClick={onPreview}
        title={filename}
        type="button"
      >
        <Icon
          aria-hidden="true"
          className={cn("size-5 shrink-0", FILE_KIND_ICON_COLORS[file.kind])}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
              {filename}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {formatShortDate(new Date(file.receivedAtMs), {
                lowercase: true,
              })}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="min-w-0 truncate">
              {[
                formatFileSize(file.attachment.size),
                sender,
                file.subject.trim() || "(no subject)",
              ].join(" · ")}
            </span>
            {file.copies > 1 ? (
              <span className="shrink-0 tabular-nums">
                In {file.copies} messages
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <Button
        aria-label={`Open conversation for ${filename}`}
        className="shrink-0 text-muted-foreground"
        onClick={onOpenThread}
        size="iconSm"
        title="Open conversation"
        type="button"
        variant="ghost"
      >
        <MessageSquareTextIcon aria-hidden="true" className="size-4" />
      </Button>
      <Button
        aria-label={`Download ${filename}`}
        className="shrink-0 text-muted-foreground"
        disabled={downloading}
        onClick={onDownload}
        size="iconSm"
        title="Download attachment"
        type="button"
        variant="ghost"
      >
        <DownloadIcon aria-hidden="true" className="size-4" />
      </Button>
    </li>
  );
}

function SenderFilter({
  senders,
  selected,
  onChange,
  onOpen,
}: {
  senders: FileSender[];
  selected: FileSender | null;
  onChange: (sender: FileSender | null) => void;
  /** Senders can change while the list is open, so they reload on opening. */
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (selected)
    return (
      <Button
        aria-label={`From ${senderLabel(selected)}. Clear sender filter`}
        className="h-8 max-w-[45%] shrink-0 gap-1.5 px-2.5"
        onClick={() => onChange(null)}
        size="sm"
        variant="secondary"
      >
        <span className="truncate">{senderLabel(selected)}</span>
        <XIcon aria-hidden="true" className="size-3.5 shrink-0" />
      </Button>
    );
  return (
    <Popover
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label="Filter by sender"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-muted-foreground"
          role="combobox"
          size="sm"
          variant="outline"
        >
          From anyone
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-0 motion-reduce:animate-none"
        collisionPadding={16}
      >
        <Command>
          <CommandInput placeholder="Search senders" />
          <CommandList>
            <CommandEmpty>No senders found.</CommandEmpty>
            <CommandGroup>
              {senders.map((sender) => (
                <CommandItem
                  key={sender.email}
                  onSelect={() => {
                    onChange(sender);
                    setOpen(false);
                  }}
                  value={`${sender.name ?? ""} ${sender.email}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {senderLabel(sender)}
                    </span>
                    {sender.name ? (
                      <span className="block truncate text-muted-foreground text-xs">
                        {sender.email}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {sender.files}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function senderLabel(sender: FileSender) {
  return sender.name || sender.email;
}
