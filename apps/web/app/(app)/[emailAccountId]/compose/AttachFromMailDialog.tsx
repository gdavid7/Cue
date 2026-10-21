"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type {
  FileEntry,
  FileKind,
  FilesPage,
  FilesQuery,
} from "@inboxzero/mail-core/queries";
import type { AttachFromMailSender } from "@/app/(app)/[emailAccountId]/compose/attach-from-mail";
import { toComposeFile } from "@/app/(app)/[emailAccountId]/compose/attach-from-mail";
import {
  FILE_KIND_FILTERS,
  FILE_KIND_ICON_COLORS,
  FILE_KIND_ICONS,
  fileAttachmentUrl,
  fileKey,
  formatFileSize,
} from "@/components/mail-files";
import { toastError } from "@/components/Toast";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useAccounts } from "@/hooks/useAccounts";
import { cn } from "@/utils";
import { fetchAttachment } from "@/utils/attachments/download";
import { formatShortDate } from "@/utils/date";
import { extractNameFromEmail } from "@/utils/email";

const PAGE_SIZE = 50;
const FILES_PER_SENDER = 5;
// A sender's files can sit past a page that read many messages and found
// none, so their group reads on a little before it gives up.
const MAX_SENDER_PAGES = 3;

type Attaching = { key: string; receivedBytes: number };

/**
 * Picks a file already on the user's mail and attaches it, reading its bytes
 * through the attachment route rather than from the user's disk. The list is
 * the Files view's, read from the mail on this device alone.
 */
export function AttachFromMailDialog({
  open,
  onOpenChange,
  ...picker
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<PickerProps, "onClose">) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[min(40rem,90dvh)] max-w-lg flex-col gap-0 overflow-hidden p-0 motion-reduce:animate-none">
        <DialogHeader className="px-4 pt-4 pb-3 text-left">
          <DialogTitle>Attach from mail</DialogTitle>
        </DialogHeader>
        {/* Mounted per opening: filters start fresh, the list is reread, and
            closing stops a download. */}
        <AttachFromMailPicker {...picker} onClose={() => onOpenChange(false)} />
        {/* Mail whose body isn't on this device has no file details yet. */}
        <DialogDescription className="shrink-0 border-border border-t px-4 py-2.5 text-xs">
          Files on older mail show up here once that mail is on this device.
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

type PickerProps = {
  /** The account sending; every other connected account is searched too. */
  emailAccountId: string;
  /** Recipients whose files are listed first. */
  senders: AttachFromMailSender[];
  /** Why the composer would refuse a file of this size, before downloading it. */
  checkFits: (attachment: FileEntry["attachment"]) => string | undefined | null;
  onAttach: (file: File) => void;
  onClose: () => void;
};

function AttachFromMailPicker({
  emailAccountId,
  senders,
  checkFits,
  onAttach,
  onClose,
}: PickerProps) {
  const client = useOptionalMailClient();
  const readFiles = client?.queryFiles?.bind(client);
  const { data: accountsData } = useAccounts();
  const connected = useMemo(
    () =>
      (accountsData?.emailAccounts ?? []).filter(
        (account) => account.account.disconnectedAt === null,
      ),
    [accountsData?.emailAccounts],
  );
  const accountIds = useMemo(
    () => [
      emailAccountId,
      ...connected
        .map((account) => account.id)
        .filter((id) => id !== emailAccountId),
    ],
    [connected, emailAccountId],
  );
  const accountEmail = (accountId: string) =>
    accountIds.length > 1
      ? connected.find((account) => account.id === accountId)?.email
      : undefined;

  const [kind, setKind] = useState<FileKind | null>(null);
  const [name, setName] = useState("");
  const deferredName = useDeferredValue(name.trim());
  const [attaching, setAttaching] = useState<Attaching | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const filters = JSON.stringify({
    accountIds,
    kind,
    name: deferredName || null,
  });
  const senderEmails = senders.map((sender) => sender.email);
  const senderFiles = useSWR(
    readFiles && senderEmails.length
      ? ["attach-from-mail-senders", filters, senderEmails.join(",")]
      : null,
    ([, key]: [string, string, string]) =>
      Promise.all(
        senderEmails.map((sender) =>
          readSenderFiles(
            (query) => {
              if (!readFiles) throw new Error("Files can't be read here");
              return readFiles(query);
            },
            {
              ...(JSON.parse(key) as Pick<
                FilesQuery,
                "accountIds" | "kind" | "name"
              >),
              sender,
            },
          ),
        ),
      ),
    { keepPreviousData: true, revalidateOnMount: true },
  );
  const pages = useSWRInfinite(
    (index, previous: FilesPage | null) => {
      if (!readFiles || (previous && !previous.nextPage)) return null;
      return [
        "attach-from-mail-files",
        filters,
        index === 0 ? null : (previous?.nextPage ?? null),
      ];
    },
    ([, key, after]: [string, string, string | null]) => {
      if (!readFiles) throw new Error("Files can't be read here");
      return readFiles({
        ...(JSON.parse(key) as Pick<
          FilesQuery,
          "accountIds" | "kind" | "name"
        >),
        sender: null,
        pageSize: PAGE_SIZE,
        after,
      });
    },
    {
      keepPreviousData: true,
      revalidateFirstPage: false,
      revalidateOnMount: true,
    },
  );

  const senderGroups = senders.map((sender, index) => ({
    sender,
    files: senderFiles.data?.[index] ?? [],
  }));
  const listedForSenders = new Set(
    senderGroups.flatMap((group) => group.files.map(fileKey)),
  );
  const loadedFiles = pages.data?.flatMap((page) => page.files) ?? [];
  const otherFiles = loadedFiles.filter(
    (file) => !listedForSenders.has(fileKey(file)),
  );
  const hasMore = Boolean(pages.data?.at(-1)?.nextPage);
  const loadingMore =
    pages.isValidating && pages.size > (pages.data?.length ?? 0);
  const { setSize } = pages;
  // Short pages are normal for a narrow filter, so the first screen fills
  // itself; past that, more loads on request.
  useEffect(() => {
    if (hasMore && !loadingMore && loadedFiles.length < PAGE_SIZE)
      setSize((size) => size + 1);
  }, [hasMore, loadingMore, loadedFiles.length, setSize]);

  const nothingListed =
    otherFiles.length === 0 &&
    senderGroups.every((group) => group.files.length === 0);
  const error = pages.error ?? senderFiles.error;
  const loading =
    !error &&
    ((!pages.data && pages.isLoading) ||
      (Boolean(senderEmails.length) && !senderFiles.data));
  const filtered = Boolean(kind || deferredName);

  useEffect(() => () => abortRef.current?.abort(), []);

  const attach = async (file: FileEntry) => {
    if (attaching) return;
    const refused = checkFits(file.attachment);
    if (refused) {
      toastError({ description: refused });
      return;
    }
    const key = fileKey(file);
    const controller = new AbortController();
    abortRef.current = controller;
    setAttaching({ key, receivedBytes: 0 });
    try {
      const blob = await fetchAttachment({
        url: fileAttachmentUrl(file),
        emailAccountId: file.accountId,
        signal: controller.signal,
        onProgress: (receivedBytes) =>
          setAttaching((current) =>
            current?.key === key ? { key, receivedBytes } : current,
          ),
      });
      if (controller.signal.aborted) return;
      onAttach(toComposeFile(blob, file.attachment));
      onClose();
    } catch {
      if (controller.signal.aborted) return;
      toastError({
        description: `Could not attach ${file.attachment.filename}.`,
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setAttaching(null);
      }
    }
  };

  const renderItem = (file: FileEntry) => (
    <FileItem
      accountEmail={accountEmail(file.accountId)}
      attaching={
        attaching?.key === fileKey(file) ? attaching.receivedBytes : null
      }
      file={file}
      key={fileKey(file)}
      onSelect={() => {
        attach(file).catch(() => undefined);
      }}
    />
  );

  return (
    <Command
      className="min-h-0 flex-1 rounded-none border-border border-t"
      label="Search file names"
      loop
      shouldFilter={false}
    >
      <CommandInput
        onValueChange={setName}
        placeholder="Search file names"
        value={name}
      />
      <div
        aria-label="File type"
        className="flex shrink-0 gap-1.5 overflow-x-auto border-border border-b px-3 py-2 scrollbar-none"
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
      <CommandList
        aria-busy={loading || undefined}
        label="Files"
        className="max-h-none min-h-0 flex-1"
      >
        {loading && nothingListed ? (
          <p
            className="px-6 py-10 text-center text-muted-foreground text-sm"
            role="status"
          >
            Loading files…
          </p>
        ) : null}
        {error ? (
          <p
            className="px-6 py-10 text-center text-muted-foreground text-sm"
            role="alert"
          >
            Your files couldn&apos;t be read. Close this and try again.
          </p>
        ) : null}
        {!loading && !error && nothingListed ? (
          <p
            className="px-6 py-10 text-center text-muted-foreground text-sm"
            role="status"
          >
            {emptyMessage({ hasMore, filtered })}
          </p>
        ) : null}
        {senderGroups.map(({ sender, files }) =>
          files.length ? (
            <CommandGroup
              heading={`Files from ${sender.label}`}
              key={sender.email}
            >
              {files.map(renderItem)}
            </CommandGroup>
          ) : null,
        )}
        {otherFiles.length ? (
          <CommandGroup
            heading={
              senderGroups.some((group) => group.files.length)
                ? "All files"
                : undefined
            }
          >
            {otherFiles.map(renderItem)}
            {hasMore ? (
              <CommandItem
                className="justify-center text-muted-foreground"
                disabled={loadingMore}
                onSelect={() => setSize((size) => size + 1)}
                value="load-more"
              >
                {loadingMore ? "Loading more files…" : "Load more files"}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}

function FileItem({
  file,
  accountEmail,
  attaching,
  onSelect,
}: {
  file: FileEntry;
  accountEmail: string | undefined;
  /** Bytes received so far while this file downloads. */
  attaching: number | null;
  onSelect: () => void;
}) {
  const Icon = FILE_KIND_ICONS[file.kind];
  const { filename, size } = file.attachment;
  const sender = extractNameFromEmail(file.from) || file.from;
  const percent =
    attaching === null || !size
      ? null
      : Math.min(99, Math.round((attaching / size) * 100));
  return (
    <CommandItem
      aria-busy={attaching !== null || undefined}
      className="gap-3 py-2"
      onSelect={onSelect}
      value={fileKey(file)}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-5 shrink-0", FILE_KIND_ICON_COLORS[file.kind])}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">
            {filename}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {formatShortDate(new Date(file.receivedAtMs), { lowercase: true })}
          </span>
        </span>
        {attaching === null ? (
          <span className="block truncate text-muted-foreground text-xs">
            {[
              formatFileSize(size),
              sender,
              file.subject.trim() || "(no subject)",
              accountEmail,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <Progress
            aria-label={`Attaching ${filename}`}
            // The shared Progress draws `value` but doesn't hand it to Radix.
            aria-valuenow={percent ?? undefined}
            className="mt-1.5 h-1"
            innerClassName="bg-primary motion-reduce:transition-none"
            value={percent}
          />
        )}
      </span>
    </CommandItem>
  );
}

async function readSenderFiles(
  read: (query: FilesQuery) => Promise<FilesPage>,
  query: Omit<FilesQuery, "pageSize" | "after">,
) {
  const files: FileEntry[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_SENDER_PAGES; page++) {
    const result = await read({ ...query, pageSize: FILES_PER_SENDER, after });
    files.push(...result.files);
    after = result.nextPage;
    if (files.length >= FILES_PER_SENDER || !after) break;
  }
  return files.slice(0, FILES_PER_SENDER);
}

function emptyMessage({
  hasMore,
  filtered,
}: {
  hasMore: boolean;
  filtered: boolean;
}) {
  if (hasMore) return "Looking through older mail…";
  if (filtered) return "No files match these filters.";
  return "No files yet.";
}
