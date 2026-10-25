"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastError, toastInfo } from "@/components/Toast";
import type { ThreadMessage } from "@/components/email-list/types";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  AttachmentTooLargeError,
  fetchAttachment,
  getAttachmentUrl,
  saveBlob,
} from "@/utils/attachments/download";
import {
  DOWNLOAD_ALL_MAX_BYTES,
  dedupeFilenames,
  selectUnderCap,
  zipAttachments,
  zipFilename,
} from "@/utils/attachments/download-all";

export function DownloadAllButton({ message }: { message: ThreadMessage }) {
  const { emailAccountId } = useAccount();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);

  const attachments = (message.attachments ?? []).filter(
    (attachment) => attachment.attachmentId,
  );
  if (!emailAccountId || attachments.length < 2) return null;

  const pending = !!progress;

  const downloadAll = async () => {
    // Made on click: a dev-mode remount would leave an eager one aborted.
    if (!controller.current || controller.current.signal.aborted)
      controller.current = new AbortController();
    const { signal } = controller.current;
    const { included, skipped } = selectUnderCap(
      attachments,
      DOWNLOAD_ALL_MAX_BYTES,
    );
    const files: { name: string; data: Uint8Array }[] = [];
    let failed = 0;
    let skippedCount = skipped.length;
    let usedBytes = 0;
    setProgress({ done: 0, total: included.length });

    try {
      for (const attachment of included) {
        try {
          const blob = await fetchAttachment({
            url: getAttachmentUrl({
              accountId: emailAccountId,
              messageId: message.id,
              attachmentId: attachment.attachmentId,
            }),
            emailAccountId,
            signal,
            maxBytes: DOWNLOAD_ALL_MAX_BYTES - usedBytes,
          });
          const data = new Uint8Array(await blob.arrayBuffer());
          signal.throwIfAborted();
          usedBytes += data.byteLength;
          files.push({ name: attachment.filename, data });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof AttachmentTooLargeError) skippedCount++;
          else failed++;
        }
        setProgress((current) =>
          current ? { ...current, done: current.done + 1 } : current,
        );
      }

      if (files.length === 0) {
        toastError({
          description:
            failed === 0
              ? `Attachments over ${LIMIT_LABEL} can't be downloaded together`
              : "Failed to download attachments",
        });
        return;
      }

      const names = dedupeFilenames(files.map((file) => file.name));
      const zip = await zipAttachments(
        files.map((file, index) => ({
          name: names[index] ?? file.name,
          data: file.data,
        })),
        signal,
      );
      signal.throwIfAborted();
      const downloaded = files.length;
      // The archive holds its own copy; don't keep every file in memory for the toast.
      files.length = 0;
      saveBlob(zip, zipFilename(message.headers.subject));

      const notes = [
        skippedCount > 0 &&
          `${skippedCount} skipped for going over the ${LIMIT_LABEL} limit`,
        failed > 0 && `${failed} failed to download`,
      ].filter(Boolean);
      if (notes.length > 0)
        toastInfo({
          title: `Downloaded ${downloaded} of ${attachments.length} attachments`,
          description: `${notes.join(", ")}.`,
        });
    } catch {
      if (!signal.aborted)
        toastError({ description: "Failed to download attachments" });
    } finally {
      setProgress(undefined);
    }
  };

  return (
    <div className="col-span-full">
      <Button
        variant="outline"
        size="sm"
        type="button"
        className="aria-disabled:pointer-events-none aria-disabled:opacity-60"
        aria-disabled={pending}
        aria-busy={pending}
        onClick={() => {
          if (!pending) downloadAll();
        }}
      >
        {pending ? (
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        ) : (
          <DownloadIcon className="mr-2 size-4" aria-hidden="true" />
        )}
        {progress
          ? `Downloading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : `Download all (${attachments.length})`}
      </Button>
      <span role="status" className="sr-only">
        {progress
          ? `Downloading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
          : ""}
      </span>
    </div>
  );
}

const LIMIT_LABEL = `${DOWNLOAD_ALL_MAX_BYTES / (1024 * 1024)} MB`;
