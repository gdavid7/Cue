import { type InferUITool, tool } from "ai";
import { z } from "zod";
import { DRIVE_APPS } from "@/utils/attachments/drive-apps";
import { saveAttachmentToDrive } from "@/utils/attachments/save-to-drive";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { posthogCaptureEvent } from "@/utils/posthog";

const saveToDriveInputSchema = z.object({
  messageId: z
    .string()
    .describe(
      "The email that has the attachment, from readEmail or search results.",
    ),
  filename: z
    .string()
    .describe("The attachment's file name exactly as listed on the email."),
  app: z
    .enum(DRIVE_APPS)
    .describe("Where to save it: googledrive or one_drive."),
});

export const saveToDriveTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Save an email attachment to the user's Google Drive or OneDrive. Use when the user asks to save or file an attachment. Requires that app to be connected in Cue; if it isn't, tell the user to connect it from Connectors. Confirm the file and destination before calling. Saves a copy; the email is not changed.",
    inputSchema: saveToDriveInputSchema,
    execute: async ({ messageId, filename, app }) => {
      logger.trace("Tracking tool call", { tool: "save_to_drive", email });
      posthogCaptureEvent(email, "AI Assistant Chat Tool Call", {
        tool: "save_to_drive",
      });

      try {
        const saved = await saveAttachmentToDrive({
          emailAccountId,
          provider,
          messageId,
          attachment: { filename },
          app,
          logger,
        });
        return { saved: true, ...saved };
      } catch (error) {
        if (error instanceof SafeError) return { error: error.message };
        logger.error("Failed to save attachment to drive", { error, app });
        return { error: "Failed to save the attachment" };
      }
    },
  });

export type SaveToDriveTool = InferUITool<ReturnType<typeof saveToDriveTool>>;
