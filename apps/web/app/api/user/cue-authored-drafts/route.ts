import { NextResponse } from "next/server";
import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import { isDraftUnmodified } from "@/utils/ai/choose-rule/draft-management";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";

// Each source's newest drafts. Older ones are long sent, cleaned up or
// deleted, and each one checked costs a mailbox read.
const RULE_DRAFTS_CHECKED = 20;
const FOLLOW_UP_DRAFTS_CHECKED = 20;
const MEETING_DRAFTS_CHECKED = 10;
const CONCURRENCY = 5;

export type CueAuthoredDraftsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailProvider(
  "user/cue-authored-drafts",
  async (request) => {
    const data = await getData({
      emailAccountId: request.auth.emailAccountId,
      provider: request.emailProvider,
      logger: request.logger,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);

/**
 * The mailbox message ids of drafts Cue wrote into the mailbox that the user
 * hasn't made their own: a rule's draft from before replies became
 * suggestions, while it still reads as Cue wrote it, and every follow-up and
 * meeting follow-up draft, whose original text Cue doesn't keep to compare.
 * Ids only. A Gmail draft id names the draft, not its message, so each is
 * read from the mailbox for its message's id.
 */
async function getData({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
}) {
  const [ruleDrafts, followUps, meetings] = await Promise.all([
    prisma.executedAction.findMany({
      where: {
        executedRule: { emailAccountId },
        type: ActionType.DRAFT_EMAIL,
        draftId: { not: null },
        OR: [
          { draftStatus: null },
          {
            draftStatus: {
              in: [
                DraftEmailStatus.PENDING,
                DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
              ],
            },
          },
        ],
      },
      select: { draftId: true, content: true },
      orderBy: { createdAt: "desc" },
      take: RULE_DRAFTS_CHECKED,
    }),
    prisma.threadTracker.findMany({
      where: { emailAccountId, followUpDraftId: { not: null } },
      select: { followUpDraftId: true },
      orderBy: { updatedAt: "desc" },
      take: FOLLOW_UP_DRAFTS_CHECKED,
    }),
    prisma.meeting.findMany({
      where: { emailAccountId, followUpDraftId: { not: null } },
      select: { followUpDraftId: true },
      orderBy: { startTime: "desc" },
      take: MEETING_DRAFTS_CHECKED,
    }),
  ]);

  const candidates = new Map<string, string | null>();
  for (const { followUpDraftId } of [...followUps, ...meetings])
    if (followUpDraftId) candidates.set(followUpDraftId, null);
  // A rule's draft with no text kept can't be told apart from an edit, so
  // it stays.
  for (const { draftId, content } of ruleDrafts)
    if (draftId && !candidates.has(draftId) && content)
      candidates.set(draftId, content);

  const messageIds = await mapWithConcurrency(
    [...candidates],
    CONCURRENCY,
    async ([draftId, originalContent]) => {
      try {
        const draft = await provider.getDraft(draftId);
        if (!draft?.id) return [];
        if (
          originalContent !== null &&
          !isDraftUnmodified({ originalContent, currentDraft: draft, logger })
        )
          return [];
        return [draft.id];
      } catch (error) {
        logger.warn("Could not read a Cue-authored draft", { error });
        // Unread, it may be Cue's, so it is left out by its own id: an
        // Outlook draft's id is its message's, and a Gmail one matches no
        // message, which costs nothing.
        return [draftId];
      }
    },
  );
  return { messageIds: [...new Set(messageIds.flat())] };
}
