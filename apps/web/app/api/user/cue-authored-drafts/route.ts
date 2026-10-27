import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionType } from "@/generated/prisma/enums";
import { isDraftUnmodified } from "@/utils/ai/choose-rule/draft-management";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider } from "@/utils/email/types";
import { SafeError } from "@/utils/error";
import { runWithGmailWaitBudget } from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";

// The lane's read limit: the hook asks about at most this many drafts.
const MAX_ITEMS = 20;
// Mailbox reads one request may make. A conversation whose drafts of Cue's
// don't fit in what's left is left unchecked, newest conversations first,
// so old drafts in some conversations don't hide the whole account's lane.
const MAX_DRAFT_READS = 40;
const MAX_MEETING_READS = 20;
// Rows one lookup may return. Past them the request fails: a lookup cut
// short may have left out one of Cue's drafts in any conversation.
const MAX_CANDIDATE_ROWS = 400;
const CONCURRENCY = 5;
// What the mailbox reads wait at the gate in all before the request defers
// (503 with a retry time) and the lane stays hidden for the account.
const GMAIL_WAIT_MS = 10_000;
// Cue claims a meeting's follow-up draft just before writing it and never
// saves it again, so an unedited one was saved within this of the claim.
const MEETING_DRAFT_SAVE_SLACK_MS = 10 * 60_000;

const idSchema = z.string().min(1).max(512);
const msSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const querySchema = z
  .object({
    // Only the newest draft per conversation is considered; the lane shows
    // no other.
    items: z
      .array(z.object({ threadId: idSchema, messageId: idSchema }))
      .min(1)
      .max(MAX_ITEMS),
    savedAtMs: z.array(msSchema).max(MAX_ITEMS),
  })
  .refine((query) => query.savedAtMs.length === query.items.length, {
    message: "savedAtMs needs one time per item",
  });

export type CueAuthoredDraftsResponse = Awaited<ReturnType<typeof getData>>;

/**
 * `?items=threadId:messageId,...` names the drafts the lane would show, each
 * by its conversation and its message (split at the last `:`), and
 * `savedAtMs=...` when each was saved, in the same order. Answers which of
 * those messages are drafts Cue wrote into the mailbox, and which it checked:
 * a draft it didn't check may be Cue's. If any of Cue's drafts it reads
 * can't be read, the request fails rather than answer for some of them; if
 * there are more meeting drafts or rows to look at than one request may, it
 * fails with 409, which asking again won't change.
 */
export const GET = withEmailProvider(
  "user/cue-authored-drafts",
  async (request) => {
    const searchParams = new URL(request.url).searchParams;
    const query = querySchema.parse({
      items: (searchParams.get("items") ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          // `searchParams` has already decoded each id once.
          const split = pair.lastIndexOf(":");
          return split < 0
            ? {}
            : {
                threadId: pair.slice(0, split),
                messageId: pair.slice(split + 1),
              };
        }),
      savedAtMs: (searchParams.get("savedAtMs") ?? "").split(","),
    });

    const data = await runWithGmailWaitBudget(GMAIL_WAIT_MS, () =>
      getData({
        ...query,
        emailAccountId: request.auth.emailAccountId,
        provider: request.emailProvider,
        logger: request.logger,
      }),
    );
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);

/**
 * Of the given drafts, the message ids of those Cue wrote into the mailbox.
 * A Gmail draft id names the draft, not its message, so each Gmail candidate
 * is read for its message's id; an Outlook draft id is its message's, so an
 * Outlook candidate is matched by id and read only to compare its text.
 * - A rule's draft (from before replies became suggestions), looked up in
 *   the given conversations: Cue's unless the user has provably changed the
 *   text Cue kept for it; with no text kept it stays Cue's.
 * - A follow-up draft, looked up in the given conversations: Cue keeps no
 *   text for it, so it is Cue's while it is a draft.
 * - A meeting's follow-up draft starts its own conversation, which the
 *   meeting doesn't keep, and has no text kept. Outlook: Cue's by id, edited
 *   or not. Gmail: read only if Cue started it within ten minutes of when one
 *   of the given drafts was saved; one saved later has been saved again, by
 *   the user, and is theirs.
 */
async function getData({
  items,
  savedAtMs,
  emailAccountId,
  provider,
  logger,
}: z.infer<typeof querySchema> & {
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
}) {
  const threadIds = [...new Set(items.map((item) => item.threadId))];
  const messageIds = new Set(items.map((item) => item.messageId));
  const draftIdIsMessageId = provider.name === "microsoft";
  const byMessageId = draftIdIsMessageId
    ? { in: [...messageIds] }
    : { not: null };

  const [ruleDrafts, followUps, meetings] = await Promise.all([
    prisma.executedAction.findMany({
      where: {
        executedRule: { emailAccountId, threadId: { in: threadIds } },
        type: ActionType.DRAFT_EMAIL,
        draftId: byMessageId,
      },
      select: {
        draftId: true,
        content: true,
        executedRule: { select: { threadId: true } },
      },
      take: MAX_CANDIDATE_ROWS + 1,
    }),
    prisma.threadTracker.findMany({
      where: {
        emailAccountId,
        threadId: { in: threadIds },
        followUpDraftId: byMessageId,
      },
      select: { followUpDraftId: true, threadId: true },
      take: MAX_CANDIDATE_ROWS + 1,
    }),
    prisma.meeting.findMany({
      where: draftIdIsMessageId
        ? { emailAccountId, followUpDraftId: byMessageId }
        : {
            emailAccountId,
            followUpDraftId: { not: null },
            // Cue writes a meeting's draft only after the meeting starts, so
            // no meeting starting after the newest window can match; saying
            // so lets the (emailAccountId, startTime) index narrow the read.
            startTime: {
              lte: new Date(
                Math.max(...savedAtMs) + MEETING_DRAFT_SAVE_SLACK_MS,
              ),
            },
            OR: savedWindows(savedAtMs).map(([from, to]) => ({
              followUpDraftStartedAt: {
                gte: new Date(from),
                lte: new Date(to),
              },
            })),
          },
      select: { followUpDraftId: true },
      take: MAX_MEETING_READS + 1,
    }),
  ]);

  // A lookup cut short may have left out one of Cue's drafts.
  if (
    ruleDrafts.length > MAX_CANDIDATE_ROWS ||
    followUps.length > MAX_CANDIDATE_ROWS ||
    meetings.length > MAX_MEETING_READS
  ) {
    logger.warn("Too many Cue drafts to check for the drafts lane", {
      ruleDrafts: ruleDrafts.length,
      followUps: followUps.length,
      meetings: meetings.length,
    });
    // 409: the same drafts would hit the same limit, so not worth retrying.
    throw new SafeError("Too many of Cue's drafts to check", 409);
  }

  // The text Cue wrote, where a changed one makes the draft the user's;
  // null where there's none to compare and the draft stays Cue's. A
  // meeting's draft has no conversation among the given ones.
  const candidates = new Map<
    string,
    { originalContent: string | null; threadId: string | null }
  >();
  for (const { draftId, content, executedRule } of ruleDrafts)
    if (draftId)
      candidates.set(draftId, {
        originalContent: content || null,
        threadId: executedRule?.threadId ?? null,
      });
  for (const { followUpDraftId, threadId } of followUps)
    if (followUpDraftId)
      candidates.set(followUpDraftId, { originalContent: null, threadId });
  for (const { followUpDraftId } of meetings)
    if (followUpDraftId)
      candidates.set(followUpDraftId, {
        originalContent: null,
        threadId: null,
      });

  const cueAuthored = new Set<string>();
  // Each conversation's reads; a meeting's draft is read whichever
  // conversations are checked.
  const readsByThread = new Map<string | null, [string, string][]>();
  for (const [draftId, { originalContent, threadId }] of candidates) {
    if (draftIdIsMessageId) {
      if (!messageIds.has(draftId)) continue;
      if (originalContent === null) {
        cueAuthored.add(draftId);
        continue;
      }
    }
    readsByThread.set(threadId, [
      ...(readsByThread.get(threadId) ?? []),
      [draftId, originalContent ?? ""],
    ]);
  }

  const toRead = readsByThread.get(null) ?? [];
  const checkedThreadIds = new Set<string>();
  const newestFirst = items
    .map((item, i) => ({ threadId: item.threadId, savedAtMs: savedAtMs[i] }))
    .sort((a, b) => b.savedAtMs - a.savedAtMs);
  for (const { threadId } of newestFirst) {
    if (checkedThreadIds.has(threadId)) continue;
    const reads = readsByThread.get(threadId) ?? [];
    if (toRead.length + reads.length > MAX_DRAFT_READS) continue;
    toRead.push(...reads);
    checkedThreadIds.add(threadId);
  }
  if (checkedThreadIds.size < threadIds.length)
    logger.info("Left some drafts lane conversations unchecked", {
      conversations: threadIds.length,
      checked: checkedThreadIds.size,
    });

  // A read that throws, including one deferred at the Gmail gate, fails the
  // request: a draft left unread may be Cue's.
  await mapWithConcurrency(
    toRead,
    CONCURRENCY,
    async ([draftId, originalContent]) => {
      const draft = await provider.getDraft(draftId);
      if (!draft?.id || !messageIds.has(draft.id)) return;
      if (
        originalContent &&
        !isDraftUnmodified({ originalContent, currentDraft: draft, logger })
      )
        return;
      cueAuthored.add(draft.id);
    },
  );

  return {
    messageIds: [...cueAuthored],
    checkedMessageIds: items
      .filter((item) => checkedThreadIds.has(item.threadId))
      .map((item) => item.messageId),
  };
}

/** Each saved time ± the meeting draft slack, overlapping windows merged. */
function savedWindows(savedAtMs: number[]) {
  const windows: [number, number][] = [];
  for (const at of [...savedAtMs].sort((a, b) => a - b)) {
    const from = at - MEETING_DRAFT_SAVE_SLACK_MS;
    const to = at + MEETING_DRAFT_SAVE_SLACK_MS;
    const last = windows.at(-1);
    if (last && from <= last[1]) last[1] = to;
    else windows.push([from, to]);
  }
  return windows;
}
