"use client";

import { CloudUploadIcon, Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import {
  toastError,
  toastLoading,
  toastSuccessWithLink,
} from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { saveAttachmentToDriveAction } from "@/utils/actions/save-attachment";
import type { DriveApp } from "@/utils/attachments/drive-apps";
import { getActionErrorMessage } from "@/utils/error";

/** Saves a copy of one attachment to a connected Google Drive or OneDrive. */
export function SaveToDriveMenu({
  emailAccountId,
  messageId,
  attachmentId,
  filename,
  drives,
}: {
  emailAccountId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  drives: { app: DriveApp; name: string }[];
}) {
  const { executeAsync, isExecuting } = useAction(
    saveAttachmentToDriveAction.bind(null, emailAccountId),
  );

  const save = async (drive: { app: DriveApp; name: string }) => {
    const toastId = toastLoading(`Saving ${filename} to ${drive.name}…`);
    const result = await executeAsync({
      messageId,
      attachmentId,
      app: drive.app,
    });
    if (result?.data) {
      toastSuccessWithLink({
        id: toastId,
        description: `Saved ${result.data.filename} to ${result.data.destination}`,
        link: result.data.url ? { label: "Open", href: result.data.url } : null,
      });
      return;
    }
    toastError({
      id: toastId,
      title: `Couldn't save to ${drive.name}`,
      description: getActionErrorMessage(result ?? {}, "Please try again."),
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="iconSm"
          type="button"
          className="relative"
          aria-label={`Save ${filename} to a drive`}
          title="Save to drive"
          disabled={isExecuting}
        >
          {isExecuting ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <CloudUploadIcon className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Save a copy to
        </DropdownMenuLabel>
        {drives.map((drive) => (
          <DropdownMenuItem key={drive.app} onSelect={() => save(drive)}>
            {drive.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
