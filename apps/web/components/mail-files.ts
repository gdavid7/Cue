import {
  FileBadgeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ImageIcon,
  type LucideIcon,
  PresentationIcon,
} from "lucide-react";
import type { FileEntry, FileKind } from "@inboxzero/mail-core/queries";
import { getAttachmentUrl } from "@/utils/attachments/download";

/** What the Files view and the composer's Attach from mail list by type. */
export const FILE_KIND_FILTERS: Array<{
  kind: FileKind | null;
  label: string;
}> = [
  { kind: null, label: "All" },
  { kind: "document", label: "Documents" },
  { kind: "spreadsheet", label: "Spreadsheets" },
  { kind: "presentation", label: "Presentations" },
  { kind: "pdf", label: "PDFs" },
  { kind: "image", label: "Images" },
  { kind: "other", label: "Other" },
];

export const FILE_KIND_ICONS: Record<FileKind, LucideIcon> = {
  document: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: PresentationIcon,
  pdf: FileBadgeIcon,
  image: ImageIcon,
  other: FileIcon,
};

export const FILE_KIND_ICON_COLORS: Record<FileKind, string> = {
  document: "text-blue-600 dark:text-blue-400",
  spreadsheet: "text-emerald-600 dark:text-emerald-400",
  presentation: "text-orange-600 dark:text-orange-400",
  pdf: "text-red-600 dark:text-red-400",
  image: "text-violet-600 dark:text-violet-400",
  other: "text-muted-foreground",
};

export function fileKey(file: FileEntry) {
  return `${file.accountId}:${file.messageId}:${file.attachment.attachmentId}`;
}

/** The file's bytes, read with the account that holds its message. */
export function fileAttachmentUrl(file: FileEntry) {
  return getAttachmentUrl({
    accountId: file.accountId,
    messageId: file.messageId,
    attachmentId: file.attachment.attachmentId,
  });
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
