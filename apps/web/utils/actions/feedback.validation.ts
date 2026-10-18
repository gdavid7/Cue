import { z } from "zod";

export const FEEDBACK_MAX_LENGTH = 5000;

export const submitFeedbackBody = z.object({
  feedback: z
    .string()
    .trim()
    .min(1, "Feedback is required")
    .max(
      FEEDBACK_MAX_LENGTH,
      `Feedback must be ${FEEDBACK_MAX_LENGTH} characters or less`,
    ),
  page: z.string().max(500).optional(),
  emailAccountId: z.string().max(100).optional(),
});
export type SubmitFeedbackBody = z.infer<typeof submitFeedbackBody>;

export const setFeedbackStatusBody = z.object({
  id: z.string(),
  status: z.enum(["NEW", "SEEN", "DONE"]),
});
