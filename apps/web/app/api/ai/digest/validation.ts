import { z } from "zod";

// The job names the message by id and the handler reads it from the mailbox,
// so queue payloads never carry addresses, subjects or bodies (founder rule R-1).
export const digestBody = z.preprocess(
  readLegacyMessageIds,
  z.object({
    emailAccountId: z.string(),
    actionId: z.string().optional(),
    messageId: z.string(),
    threadId: z.string(),
  }),
);

export type DigestBody = z.infer<typeof digestBody>;

// TODO(RD-3b): remove after one deploy. Jobs queued before ids replaced the
// message carry it whole; only its ids are kept and the rest is dropped.
function readLegacyMessageIds(value: unknown) {
  if (!value || typeof value !== "object" || !("message" in value)) {
    return value;
  }
  const { message, ...rest } = value as { message?: unknown };
  if (!message || typeof message !== "object") return rest;
  const { id, threadId } = message as { id?: unknown; threadId?: unknown };
  return { ...rest, messageId: id, threadId };
}
