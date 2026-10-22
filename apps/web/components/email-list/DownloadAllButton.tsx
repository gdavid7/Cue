"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastError, toastInfo } from "@/components/Toast";
import type { ThreadMessage } from "@/components/email-list/types";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
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
  const controller = useRef(new AbortController());
  // The message id is the trigger: a different message must cancel this one's download.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, [emailAccountId, message.id]);

  const attachments = (message.attachments ?? []).filter(
    (attachment) => attachment.attachmentId,
  );
  if (!emailAccountId || attachments.length < 2) return null;

  const pending = !!progress;

  const downloadAll = async () => {
    const signal = controller.current.signal;
    const { included, skipped } = selectUnderCap(
      attachments,
      DOWNLOAD_ALL_MAX_BYTES,
    );
    const files: { name: string; data: Uint8Array }[] = [];
    let failed = 0;
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
        } catch {
          signal.throwIfAborted();
          failed++;
        }
        setProgress((current) =>
          current ? { ...current, done: current.done + 1 } : current,
        );
      }

      if (files.length === 0) {
        toastError({ description: "Failed to download attachments" });
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
      saveBlob(zip, zipFilename(message.headers.subject));

      const notes = [
        skipped.length > 0 &&
          `${skipped.length} skipped for going over the 100 MB limit`,
        failed > 0 && `${failed} failed to download`,
      ].filter(Boolean);
      if (notes.length > 0)
        toastInfo({
          title: `Downloaded ${files.length} of ${attachments.length} attachments`,
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
        title="Download all attachments as one zip file"
        aria-busy={pending}
        disabled={pending}
        loading={pending}
        onClick={downloadAll}
      >
        {!pending && (
          <DownloadIcon className="mr-2 size-4" aria-hidden="true" />
        )}
        {progress
          ? `Zipping ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : `Download all (${attachments.length})`}
      </Button>
    </div>
  );
}
