import { randomUUID } from "node:crypto";
import { ActionType } from "@/generated/prisma/enums";
import { resolveActionAttachmentsWithFailures } from "@/utils/ai/action-attachments";
import type { EmailForAction, ExecutedRuleForAction } from "@/utils/ai/types";
import type { DraftAttachment, EmailProvider } from "@/utils/email/types";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Puts the files a rule's reply carries (its configured files and the ones
 * its AI picked) on the mailbox draft that reply just became. Until then they
 * stay with the suggestion in Cue, as its text does.
 *
 * The user was told these files go with the reply, so a file that can't be
 * fetched or attached stops it: the just-made draft is removed, so trying
 * again doesn't leave a second one, and the error names the file.
 */
export async function attachRuleSuggestionFiles({
  provider,
  draftId,
  executedActionId,
  filenames,
  emailAccount,
  logger,
}: {
  provider: EmailProvider;
  draftId: string;
  executedActionId: string;
  /** The rule's files the user kept; all of them when not given. */
  filenames?: string[];
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

  const { attachments: files, failedFilenames } =
    await resolveActionAttachmentsWithFailures({
      email: { id: action.executedRule.messageId } as EmailForAction,
      emailAccount,
      executedRule: action.executedRule as ExecutedRuleForAction,
      logger,
      staticAttachments: action.staticAttachments,
      selectedAttachments: action.selectedAttachments,
      includeAiSelectedAttachments: true,
      onlyFilenames: filenames,
    });
  if (failedFilenames.length) {
    await discardDraft({ provider, draftId, logger });
    throw new SafeError(couldNotAttachMessage(failedFilenames));
  }

  let listed: DraftAttachment[] | null = null;
  for (const file of files) {
    const filename = file.filename ? String(file.filename) : "attachment";
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content ?? ""));
    try {
      const result = await provider.addDraftAttachment(draftId, {
        id: randomUUID(),
        filename,
        mimeType: file.contentType ?? "application/octet-stream",
        size: content.length,
        disposition: "attachment",
        content,
      });
      listed = result.attachments;
    } catch (error) {
      logger.warn("Failed to attach a rule's file to its draft", { error });
      await discardDraft({ provider, draftId, logger });
      throw new SafeError(couldNotAttachMessage([filename]));
    }
  }
  return listed;
}

function couldNotAttachMessage(filenames: string[]) {
  return `Couldn't attach ${filenames.join(", ")}. Try again or remove it.`;
}

async function discardDraft({
  provider,
  draftId,
  logger,
}: {
  provider: EmailProvider;
  draftId: string;
  logger: Logger;
}) {
  await provider.deleteDraft(draftId).catch((error) => {
    logger.warn("Failed to remove the draft a rule's files couldn't join", {
      error,
    });
  });
}
