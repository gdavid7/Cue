import { z } from "zod";
import { DRIVE_APPS } from "@/utils/attachments/drive-apps";

export const saveAttachmentToDriveBody = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  app: z.enum(DRIVE_APPS),
});
export type SaveAttachmentToDriveBody = z.infer<
  typeof saveAttachmentToDriveBody
>;
