import { z } from "zod";
import {
  accountIdSchema,
  conversationKeySchema,
  localRevisionSchema,
  messageKeySchema,
  operationKeySchema,
} from "./identities";

export const metadataChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive") }),
  z.object({ kind: z.literal("unarchive") }),
  z.object({ kind: z.literal("set_read"), read: z.boolean() }),
  z.object({ kind: z.literal("set_starred"), starred: z.boolean() }),
  z.object({ kind: z.literal("trash") }),
  z.object({ kind: z.literal("restore_from_trash") }),
  z.object({ kind: z.literal("set_spam"), spam: z.boolean() }),
  z.object({ kind: z.literal("move"), folderId: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("set_membership"),
    membership: z.enum(["label", "category"]),
    id: z.string().min(1).max(256),
    present: z.boolean(),
  }),
  z.object({
    kind: z.literal("snooze"),
    untilMs: z.number().int().nonnegative(),
  }),
]);
export type MetadataChange = z.infer<typeof metadataChangeSchema>;

/**
 * Someone is waiting on the change, as on an undo: it is sent ahead of queued
 * changes to other messages, never ahead of earlier ones to the same
 * messages. Omitted, commands go in the order they were admitted. Engines
 * that predate it ignore it and send in order.
 */
const commandPrioritySchema = z.literal("interactive");

export const submitMetadataCommandSchema = z.object({
  accountId: accountIdSchema,
  commandId: z.string().min(1).max(128),
  targets: z.array(messageKeySchema).min(1).max(10_000),
  change: metadataChangeSchema,
  priority: commandPrioritySchema.optional(),
});
export type SubmitMetadataCommand = z.infer<typeof submitMetadataCommandSchema>;

export const submitConversationCommandSchema = z.object({
  accountId: accountIdSchema,
  commandId: z.string().min(1).max(128),
  conversations: z.array(conversationKeySchema).min(1).max(500),
  change: metadataChangeSchema,
  /**
   * Reach every message, the user's own Sent and Drafts copies included, as
   * a change made in Sent or Drafts does. Engines that predate it ignore it
   * and already act on every message.
   */
  wholeConversation: z.boolean().optional(),
  priority: commandPrioritySchema.optional(),
  observedRevision: localRevisionSchema,
});
export type SubmitConversationCommand = z.infer<
  typeof submitConversationCommandSchema
>;

export const admissionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["queued", "preparing", "already_recorded"]),
    operation: operationKeySchema,
    revision: localRevisionSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    code: z.enum([
      "invalid",
      "unsupported",
      "storage_unavailable",
      "stale_selection",
      "queue_full",
    ]),
  }),
]);
export type Admission = z.infer<typeof admissionSchema>;

export const mailCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("metadata"),
    command: submitMetadataCommandSchema,
  }),
  z.object({
    kind: z.literal("conversations"),
    command: submitConversationCommandSchema,
  }),
]);
export type MailCommand = z.infer<typeof mailCommandSchema>;
