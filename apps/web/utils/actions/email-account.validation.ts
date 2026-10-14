import { z } from "zod";

export const updateSentWithSignatureBody = z.object({
  enabled: z.boolean(),
});

export const updateHiddenAiDraftLinksBody = z.object({
  enabled: z.boolean(),
});

export const updateSentMessageOpenTrackingBody = z.object({
  enabled: z.boolean(),
});
