import { randomUUID } from "node:crypto";
import { ActionType } from "@/generated/prisma/enums";
import { resolveActionAttachments } from "@/utils/ai/action-attachments";
import type { EmailForAction, ExecutedRuleForAction } from "@/utils/ai/types";
import type { DraftAttachment, EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Puts the files a rule's reply carries (its configured files and the ones
 * its AI picked) on the mailbox draft that reply just became. Until then they
 * stay with the suggestion in Cue, as its text does.
 */
export async function attachRuleSuggestionFiles({
  provider,
  draftId,
  executedActionId,
  emailAccount,
  logger,
}: {
  provider: EmailProvider;
  draftId: string;
  executedActionId: string;
  emailAccount: { id: string; userId: string; email: string };
  logger: Logger;
}): Promise<DraftAttachment[] | null> {
  const action = await prisma.executedAction.findFirst({
    where: {
      id: executedActionId,
      type: ActionType.DRAFT_EMAIL,
      draftId: null,
      executedRule: { emailAccountId: emailAccount.id },
    },
    select: {
      staticAttachments: true,
      selectedAttachments: true,
      executedRule: true,
    },
  });
  if (!action) return null;

  const files = await resolveActionAttachments({
    email: { id: action.executedRule.messageId } as EmailForAction,
    emailAccount,
    executedRule: action.executedRule as ExecutedRuleForAction,
    logger,
    staticAttachments: action.staticAttachments,
    selectedAttachments: action.selectedAttachments,
    includeAiSelectedAttachments: true,
  });

  let listed: DraftAttachment[] | null = null;
  for (const file of files) {
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content ?? ""));
    const result = await provider.addDraftAttachment(draftId, {
      id: randomUUID(),
      filename: file.filename ? String(file.filename) : "attachment",
      mimeType: file.contentType ?? "application/octet-stream",
      size: content.length,
      disposition: "attachment",
      content,
    });
    listed = result.attachments;
  }
  return listed;
}
