import { z } from "zod";

const senderSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
});

// The job names its senders by the stored message rows they were found on,
// so queue payloads never carry sender addresses (founder rule R-1).
export const aiCategorizeSendersSchema = z.object({
  emailAccountId: z.string(),
  senderMessageIds: z.array(z.string()).optional(),
  // TODO(RD-3b): remove after one deploy. Jobs queued before ids replaced
  // addresses still carry the senders themselves.
  senders: z.array(senderSchema).optional(),
});
export type AiCategorizeSendersJob = {
  emailAccountId: string;
  senderMessageIds: string[];
};
export type Sender = z.infer<typeof senderSchema>;
