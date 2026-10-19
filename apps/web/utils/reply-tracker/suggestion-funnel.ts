import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * The stages of a rule's reply suggestion, from written to sent or turned
 * down. Each is recorded once per suggestion, by its executed action's ID.
 */
export const REPLY_SUGGESTION_STAGES = [
  "generated",
  "shown",
  "opened",
  "edited",
  "sent",
  "dismissed",
] as const;
type ReplySuggestionStage = (typeof REPLY_SUGGESTION_STAGES)[number];

export const SIMILARITY_BUCKETS = ["unchanged", "light", "heavy"] as const;
type SimilarityBucket = (typeof SIMILARITY_BUCKETS)[number];

export const FUNNEL_WINDOWS_DAYS = [7, 30] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
// Bounds the admin page's read; far above what the beta writes in 30 days.
const MAX_FUNNEL_ROWS = 100_000;

/**
 * One structured line per stage. IDs, the stage and the similarity numbers
 * only: never the suggestion's text, recipients or subject.
 */
export function logReplySuggestionStage({
  logger,
  stage,
  executedActionId,
  similarityScore,
}: {
  logger: Logger;
  stage: ReplySuggestionStage;
  executedActionId: string;
  /** For "sent": how close the sent reply was to the suggestion, 0 to 1. */
  similarityScore?: number;
}) {
  logger.info("Reply suggestion funnel", {
    funnel: "reply-suggestion",
    stage,
    executedActionId,
    ...(similarityScore === undefined
      ? {}
      : {
          similarityScore: Math.round(similarityScore * 100) / 100,
          similarityBucket: getSimilarityBucket(similarityScore),
        }),
  });
}

/**
 * How much the user changed a suggestion before sending it: sent as written,
 * lightly edited, or mostly rewritten.
 */
export function getSimilarityBucket(score: number): SimilarityBucket {
  if (score >= 0.95) return "unchanged";
  if (score >= 0.7) return "light";
  return "heavy";
}

/**
 * Counts for each stage, for suggestions written in the last 7 and 30 days.
 * Each window follows the suggestions written in it to wherever they got.
 */
export async function getReplySuggestionFunnel(now = new Date()) {
  const longest = Math.max(...FUNNEL_WINDOWS_DAYS);
  const rows = await prisma.executedAction.findMany({
    where: {
      type: ActionType.DRAFT_EMAIL,
      // A suggestion waits in Cue: no mailbox draft, and a status from the
      // moment it was written.
      draftId: null,
      draftStatus: { not: null },
      createdAt: { gte: new Date(now.getTime() - longest * DAY_MS) },
    },
    select: {
      createdAt: true,
      draftStatus: true,
      replySuggestionShownAt: true,
      replySuggestionOpenedAt: true,
      draftSendLog: { select: { similarityScore: true } },
      suggestedReplyDraft: {
        select: { draftSendLog: { select: { similarityScore: true } } },
      },
    },
    take: MAX_FUNNEL_ROWS,
  });
  return {
    truncated: rows.length === MAX_FUNNEL_ROWS,
    windows: FUNNEL_WINDOWS_DAYS.map((days) =>
      summarizeFunnelWindow(
        rows.filter(
          (row) => now.getTime() - row.createdAt.getTime() < days * DAY_MS,
        ),
        days,
      ),
    ),
  };
}

type FunnelRow = {
  draftStatus: DraftEmailStatus | null;
  replySuggestionShownAt: Date | null;
  replySuggestionOpenedAt: Date | null;
  draftSendLog: { similarityScore: number } | null;
  suggestedReplyDraft: {
    draftSendLog: { similarityScore: number } | null;
  } | null;
};

export function summarizeFunnelWindow(rows: FunnelRow[], days: number) {
  const counts: Record<ReplySuggestionStage, number> = {
    generated: rows.length,
    shown: 0,
    opened: 0,
    edited: 0,
    sent: 0,
    dismissed: 0,
  };
  const sentBySimilarity: Record<SimilarityBucket, number> = {
    unchanged: 0,
    light: 0,
    heavy: 0,
  };
  for (const row of rows) {
    if (row.replySuggestionShownAt) counts.shown++;
    if (row.replySuggestionOpenedAt) counts.opened++;
    if (row.suggestedReplyDraft) counts.edited++;
    if (row.draftStatus === DraftEmailStatus.DISMISSED) counts.dismissed++;
    if (row.draftStatus === DraftEmailStatus.LIKELY_SENT) {
      counts.sent++;
      // An edited suggestion was compared through the draft it became.
      const log =
        row.suggestedReplyDraft?.draftSendLog ?? row.draftSendLog ?? null;
      if (log) sentBySimilarity[getSimilarityBucket(log.similarityScore)]++;
    }
  }
  return { days, counts, sentBySimilarity };
}
