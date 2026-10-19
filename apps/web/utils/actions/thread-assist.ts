"use server";

import {
  ActionType,
  DraftEmailStatus,
  SystemType,
} from "@/generated/prisma/enums";
import { actionClient } from "@/utils/actions/safe-action";
import {
  dismissReplySuggestionBody,
  markNeedsReplyBody,
  recordSuggestedReplyDraftBody,
  saveSuggestedReplyBody,
} from "@/utils/actions/thread-assist.validation";
import { isSameEmailAddress } from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import { createEmailProvider } from "@/utils/email/provider";
import { buildDraftReplyBody } from "@/utils/email/reply-body";
import { SafeError } from "@/utils/error";
import { createReplyContent } from "@/utils/gmail/reply";
import { GmailLabel } from "@/utils/gmail/label";
import { HANDLED_LABELS } from "@/utils/home/get-home";
import prisma from "@/utils/prisma";
import { updateThreadTrackers } from "@/utils/reply-tracker/handle-conversation-status";
import { applyThreadStatusLabel } from "@/utils/reply-tracker/label-helpers";
import { getSuggestedReplySettings } from "@/utils/thread-context/suggest-reply";
import { canWriteRequestedReplies } from "@/utils/rule/draft-replies-enabled";
import type { ParsedMessage } from "@/utils/types";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";

/**
 * The user's correction when the AI got a conversation wrong: back in the
 * inbox, out of the category it was filed under, and tracked as needing a reply.
 */
export const markNeedsReplyAction = actionClient
  .metadata({ name: "markNeedsReply" })
  .inputSchema(markNeedsReplyBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { threadId },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      const [thread, labels] = await Promise.all([
        emailProvider.getThread(threadId),
        emailProvider.getLabels(),
      ]);
      const latest = thread.messages.at(-1);
      if (!latest) throw new SafeError("Conversation not found.");

      const onThread = new Set(
        thread.messages.flatMap((m) => m.labelIds ?? []),
      );
      const filed = labels
        .filter(
          (l) =>
            onThread.has(l.id) &&
            HANDLED_LABELS.some(
              (n) => n.toLowerCase() === l.name.toLowerCase(),
            ),
        )
        .map((l) => l.id);

      // Sequential: Outlook rewrites a message's whole category list per
      // write, so overlapping label changes can lose one.
      await emailProvider.unarchiveThread(threadId);
      if (filed.length) await emailProvider.removeThreadLabels(threadId, filed);
      await applyThreadStatusLabel({
        emailAccountId,
        threadId,
        messageId: latest.id,
        systemType: SystemType.TO_REPLY,
        provider: emailProvider,
        logger,
      });
      await updateThreadTrackers({
        emailAccountId,
        threadId,
        messageId: latest.id,
        sentAt: new Date(getMessageTimestamp(latest)),
        status: SystemType.TO_REPLY,
      });
    },
  );

/**
 * Saves a suggested reply, as the user edited it, as the conversation's reply
 * draft. Like Gmail, a conversation has one: saving again rewrites it.
 */
export const saveSuggestedReplyAction = actionClient
  .metadata({ name: "saveSuggestedReply" })
  .inputSchema(saveSuggestedReplyBody)
  .action(
    async ({
      ctx: { emailAccountId, emailAccount, provider, logger, userId },
      parsedInput: { threadId, content, suggested },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      const thread = await emailProvider.getThread(threadId, {
        includeDrafts: true,
      });
      const isDraft = (m: ParsedMessage) =>
        m.labelIds?.includes(GmailLabel.DRAFT) ?? false;
      const messages = thread.messages.filter((m) => !isDraft(m));
      const replyTo =
        messages.findLast(
          (m) => !isSameEmailAddress(m.headers.from, emailAccount.email),
        ) ?? messages.at(-1);
      if (!replyTo) throw new SafeError("Conversation not found.");

      const body = await buildDraftReplyBody({
        text: content,
        emailAccountId,
      });
      const existing = thread.messages.findLast(isDraft);
      const existingDraft =
        existing &&
        (await emailProvider.getDraftReferenceForMessage(existing.id));
      let draftId: string;
      if (existingDraft) {
        await emailProvider.updateDraft(existingDraft.id, {
          messageHtml: createReplyContent({
            textContent: body,
            message: replyTo,
          }).html,
        });
        draftId = existingDraft.id;
      } else {
        const created = await emailProvider.draftEmail(
          replyTo,
          { content: body },
          [emailAccount.email, ...(await getUserOwnAddresses(userId))],
        );
        if (!created.draftId)
          throw new SafeError("Drafts are turned off on this server.");
        draftId = created.draftId;
      }

      // Remember the suggestion as Cue wrote it, not the edited text, so edits
      // made here and later in the mail app both teach reply memories when
      // the draft is sent. Without the original there is nothing to compare
      // against, so the draft is saved without being remembered.
      if (
        suggested &&
        canWriteRequestedReplies(
          (await getSuggestedReplySettings(emailAccountId)).draftReplies,
        )
      ) {
        try {
          await prisma.suggestedReplyDraft.upsert({
            where: { emailAccountId_draftId: { emailAccountId, draftId } },
            create: {
              emailAccountId,
              threadId,
              messageId: replyTo.id,
              draftId,
              content: suggested,
            },
            update: { messageId: replyTo.id, content: suggested },
          });
        } catch (error) {
          // The draft is saved; only learning from its edits is lost.
          logger.error("Failed to record saved suggested reply", { error });
        }
      }

      return { draftId };
    },
  );

/**
 * Remembers which suggestion a reply draft started from, once the user's
 * first edit made it a mailbox draft, so the sent reply's edits teach reply
 * memories. A rule's suggestion is read here rather than taken from the
 * browser, and settles with the draft when it is sent.
 */
export const recordSuggestedReplyDraftAction = actionClient
  .metadata({ name: "recordSuggestedReplyDraft" })
  .inputSchema(recordSuggestedReplyDraftBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: {
        threadId,
        messageId,
        draftId,
        executedActionId,
        suggested,
      },
    }) => {
      const settings = await getSuggestedReplySettings(emailAccountId);
      if (!canWriteRequestedReplies(settings.draftReplies)) return;

      const ruleSuggestion = executedActionId
        ? await prisma.executedAction.findFirst({
            where: {
              id: executedActionId,
              type: ActionType.DRAFT_EMAIL,
              draftId: null,
              executedRule: { emailAccountId, threadId },
            },
            select: { id: true, content: true },
          })
        : null;
      const content = ruleSuggestion?.content ?? suggested;
      if (!content) return;

      const upsert = prisma.suggestedReplyDraft.upsert({
        where: { emailAccountId_draftId: { emailAccountId, draftId } },
        create: {
          emailAccountId,
          threadId,
          messageId,
          draftId,
          content,
          executedActionId: ruleSuggestion?.id,
        },
        update: {
          messageId,
          content,
          executedActionId: ruleSuggestion?.id,
        },
      });
      try {
        // A suggestion belongs to one draft: the newest, when a discarded
        // draft's record still holds it.
        await (ruleSuggestion
          ? prisma.$transaction([
              prisma.suggestedReplyDraft.updateMany({
                where: {
                  executedActionId: ruleSuggestion.id,
                  NOT: { emailAccountId, draftId },
                },
                data: { executedActionId: null },
              }),
              upsert,
            ])
          : upsert);
      } catch (error) {
        // The draft is saved; only learning from its edits is lost.
        logger.error("Failed to record suggested reply draft", { error });
      }
    },
  );

/**
 * The user turned down the rule's suggestion in the reader. Nothing was in
 * the mailbox, so nothing there changes.
 */
export const dismissReplySuggestionAction = actionClient
  .metadata({ name: "dismissReplySuggestion" })
  .inputSchema(dismissReplySuggestionBody)
  .action(
    async ({ ctx: { emailAccountId }, parsedInput: { executedActionId } }) => {
      await prisma.executedAction.updateMany({
        where: {
          id: executedActionId,
          type: ActionType.DRAFT_EMAIL,
          draftId: null,
          draftStatus: DraftEmailStatus.PENDING,
          executedRule: { emailAccountId },
        },
        data: { draftStatus: DraftEmailStatus.DISMISSED },
      });
    },
  );
