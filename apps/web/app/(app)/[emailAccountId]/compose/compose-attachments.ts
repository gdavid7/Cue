import {
  EMAIL_ATTACHMENT_LIMITS,
  EMAIL_INLINE_IMAGE_MIME_TYPES,
  type EmailAttachmentMetadata,
  validateEmailAttachmentMetadata,
} from "@inboxzero/email-editor/core";
import type { DraftAttachment } from "@/utils/email/types";
import type { ComposeAttachmentReference } from "@/utils/mail-engine/reply-drafts";

export type ComposeAttachment = EmailAttachmentMetadata & {
  /** Set once the file is on the mailbox draft; it removes the file later. */
  draftAttachmentId?: string;
  status: "uploading" | "uploaded" | "failed";
  error?: string;
  previewUrl?: string;
  /**
   * An inline image this composer placed in the editor. Images that came
   * with the draft's original HTML are left alone even when the editor
   * doesn't track them.
   */
  managed?: boolean;
};

/**
 * After a change to the mailbox draft, its list is the truth for files
 * already on it. Known files keep the local id their bytes are stored under;
 * files still uploading, or that failed, stay as they are.
 */
export function mergeDraftAttachments(
  current: ComposeAttachment[],
  listed: DraftAttachment[],
): ComposeAttachment[] {
  const uploaded = listed.map((item): ComposeAttachment => {
    const known = current.find(
      (attachment) =>
        attachment.draftAttachmentId === item.id ||
        (item.contentId && attachment.contentId === item.contentId),
    );
    return {
      id: known?.id ?? item.id,
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
      disposition: item.disposition,
      ...(item.contentId ? { contentId: item.contentId } : {}),
      draftAttachmentId: item.id,
      status: "uploaded",
      ...(known?.previewUrl ? { previewUrl: known.previewUrl } : {}),
      ...(known?.managed ? { managed: true } : {}),
    };
  });
  const pending = current.filter(
    (attachment) =>
      attachment.status !== "uploaded" &&
      !uploaded.some((item) => item.id === attachment.id),
  );
  return [...uploaded, ...pending];
}

/**
 * What the local draft keeps of an attachment: a reference to the file on the
 * mailbox draft, never its bytes. Files not on the draft yet aren't kept.
 */
export function toAttachmentReference({
  previewUrl: _previewUrl,
  status,
  error: _error,
  managed: _managed,
  draftAttachmentId,
  ...attachment
}: ComposeAttachment): ComposeAttachmentReference[] {
  return status === "uploaded" && draftAttachmentId
    ? [{ ...attachment, draftAttachmentId }]
    : [];
}

export function toAttachmentMetadata({
  id,
  filename,
  mimeType,
  size,
  disposition,
  contentId,
}: ComposeAttachment): EmailAttachmentMetadata {
  return {
    id,
    filename,
    mimeType,
    size,
    disposition,
    ...(contentId ? { contentId } : {}),
  };
}

// Images this composer placed in the editor go out as cid: references to
// their draft attachments; failed uploads have nothing to reference.
export function getEditorInlineAttachments(attachments: ComposeAttachment[]) {
  return attachments.filter(
    (attachment) =>
      attachment.managed &&
      attachment.disposition === "inline" &&
      attachment.status !== "failed",
  );
}

/**
 * Where pasted or dropped files go, as in Gmail: images that mail clients
 * show in the body go inline when they land in it, and every other file is
 * attached rather than refused.
 */
export function routeComposeFiles(
  files: File[],
  { into, inlineCount }: { into: "body" | "window"; inlineCount: number },
) {
  const inline: File[] = [];
  const attachments: File[] = [];
  for (const file of files) {
    const canInline =
      into === "body" &&
      inlineCount + inline.length < EMAIL_ATTACHMENT_LIMITS.maxInlineFiles &&
      file.size <= EMAIL_ATTACHMENT_LIMITS.maxInlineBytes &&
      (EMAIL_INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(file.type);
    (canInline ? inline : attachments).push(file);
  }
  return { inline, attachments };
}

/**
 * Adds files in order while they fit, so one large file doesn't keep the
 * others off the draft. The first refusal explains why the rest were left.
 */
export function fitComposeAttachments<T extends EmailAttachmentMetadata>({
  existing,
  candidates,
  maxTotalBytes,
}: {
  existing: EmailAttachmentMetadata[];
  candidates: T[];
  maxTotalBytes: number;
}) {
  const accepted: T[] = [];
  const rejected: T[] = [];
  let error: string | undefined;
  for (const candidate of candidates) {
    const validation = validateEmailAttachmentMetadata(
      [...existing, ...accepted, candidate],
      { maxTotalBytes },
    );
    if (validation.valid) {
      accepted.push(candidate);
    } else {
      rejected.push(candidate);
      error ??= validation.error;
    }
  }
  return { accepted, rejected, error };
}

export function describeUnattachedFiles(
  rejected: Pick<EmailAttachmentMetadata, "filename">[],
  reason: string,
) {
  const names = rejected.map(({ filename }) => filename);
  return names.length === 1
    ? `${names[0]} wasn't attached. ${reason}`
    : `${names.length} files weren't attached (${names.join(", ")}). ${reason}`;
}

/**
 * Gmail can only replace a draft whole, so each save re-reads and re-uploads
 * every attached file (about 2.4x their size in transfer). Saves are spaced
 * by how much is attached; the device keeps every keystroke meanwhile, and
 * hiding, closing or sending still saves at once.
 */
export function getGmailAttachmentDraftSaveIntervalMs(attachedBytes: number) {
  if (!attachedBytes) return 0;
  return Math.min(
    MAX_GMAIL_DRAFT_SAVE_INTERVAL_MS,
    Math.max(
      MIN_GMAIL_DRAFT_SAVE_INTERVAL_MS,
      attachedBytes / ATTACHED_BYTES_PER_SAVE_INTERVAL_MS,
    ),
  );
}

const MIN_GMAIL_DRAFT_SAVE_INTERVAL_MS = 15_000;
const MAX_GMAIL_DRAFT_SAVE_INTERVAL_MS = 120_000;
// 200 bytes per ms: 3 MB attached saves every 15 s, 10 MB every 50 s.
const ATTACHED_BYTES_PER_SAVE_INTERVAL_MS = 200;
