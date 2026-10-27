import { z } from "zod";

export const mailboxRoleSchema = z.enum([
  "inbox",
  "sent",
  "draft",
  "trash",
  "spam",
]);
export type MailboxRole = z.infer<typeof mailboxRoleSchema>;

export const inboxSectionSchema = z.enum(["focused", "other"]);
export type InboxSection = z.infer<typeof inboxSectionSchema>;

export const MAX_ATTACHMENT_CONTENT_ID_LENGTH = 1024;
export const MAX_ATTACHMENT_ID_LENGTH = 2048;

export const messageAttachmentDescriptorSchema = z.object({
  attachmentId: z.string().min(1).max(MAX_ATTACHMENT_ID_LENGTH),
  filename: z.string().max(1024),
  mimeType: z.string().max(256),
  size: z.number().int().nonnegative(),
  inline: z.boolean(),
  contentId: z
    .string()
    .max(MAX_ATTACHMENT_CONTENT_ID_LENGTH)
    .nullable()
    .optional(),
});
export type MessageAttachmentDescriptor = z.infer<
  typeof messageAttachmentDescriptorSchema
>;

export const MAX_RECIPIENTS = 500;
// RFC 5322's line limit; a longer header can't be a real Message-ID.
export const MAX_INTERNET_MESSAGE_ID_LENGTH = 998;
// The furthest real time zones sit from UTC (UTC-12 and UTC+14).
export const MIN_UTC_OFFSET_MINUTES = -12 * 60;
export const MAX_UTC_OFFSET_MINUTES = 14 * 60;

export const messageMetadataSchema = z.object({
  subject: z.string().max(16_384),
  preview: z.string().max(16_384),
  externalUrl: z.string().max(16_384).nullable().optional(),
  from: z.string().max(4096),
  to: z.array(z.string().max(4096)).max(MAX_RECIPIENTS),
  cc: z.array(z.string().max(4096)).max(MAX_RECIPIENTS),
  bcc: z.array(z.string().max(4096)).max(MAX_RECIPIENTS).optional(),
  receivedAtMs: z.number().int(),
  read: z.boolean(),
  starred: z.boolean(),
  folderId: z.string().max(256).nullable(),
  inboxSection: inboxSectionSchema.nullable().optional(),
  labelIds: z.array(z.string().max(256)).max(500),
  categoryIds: z.array(z.string().max(256)).max(500),
  roles: z.array(mailboxRoleSchema).max(8),
  hasAttachments: z.boolean(),
  snoozedUntilMs: z.number().int().nullable().optional(),
  /**
   * The RFC 5322 Message-ID header, the same in every mailbox the message
   * reached, so one message in two of the user's accounts can show once.
   */
  internetMessageId: z
    .string()
    .min(1)
    .max(MAX_INTERNET_MESSAGE_ID_LENGTH)
    .optional(),
  /**
   * The UTC offset, in minutes, written in the sender's Date header, so a
   * reply can show the hour it is for them. Absent when the header gave none.
   */
  senderUtcOffsetMinutes: z
    .number()
    .int()
    .min(MIN_UTC_OFFSET_MINUTES)
    .max(MAX_UTC_OFFSET_MINUTES)
    .optional(),
});
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export const messageMetadataPatchSchema = messageMetadataSchema.partial();
export type MessageMetadataPatch = z.infer<typeof messageMetadataPatchSchema>;

/**
 * A Message-ID as two mailboxes' copies of one message compare: some
 * providers give it without its angle brackets, and some change its case.
 */
export function normalizeInternetMessageId(
  value: string | null | undefined,
): string | null {
  const id = value
    ?.trim()
    .replace(/^<(.*)>$/, "$1")
    .trim()
    .toLowerCase();
  return id || null;
}
