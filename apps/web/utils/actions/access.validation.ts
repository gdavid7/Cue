import { z } from "zod";
import { GMAIL_DOMAINS } from "@/utils/access/config";

export const requestAccessBody = z.object({
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .refine(
      (email) =>
        GMAIL_DOMAINS.includes(email.split("@").pop()?.toLowerCase() ?? ""),
      "Enter a Gmail address (ending in @gmail.com)",
    ),
  // Honeypot: hidden from people, filled in by bots.
  website: z.string().optional(),
});
export type RequestAccessBody = z.infer<typeof requestAccessBody>;

export const approveAccessRequestsBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export const approveAccessEmailBody = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});
export type ApproveAccessEmailBody = z.infer<typeof approveAccessEmailBody>;

export const accessRequestIdBody = z.object({ id: z.string().min(1) });
