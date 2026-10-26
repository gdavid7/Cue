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
// Mailbox reads one request may make. Past them the request fails rather
// than answer for some drafts, so the lane stays hidden for the account
// instead of spending its Gmail budget.
const MAX_DRAFT_READS = 40;
const MAX_MEETING_READS = 20;
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
    savedFromMs: msSchema,
    savedToMs: msSchema,
  })
  .refine((query) => query.savedFromMs <= query.savedToMs, {
    message: "savedFromMs must not be after savedToMs",
  })
  .refine(
    (query) =>
      query.savedAtMs.length === query.items.length &&
      query.savedAtMs.every(
        (at) => at >= query.savedFromMs && at <= query.savedToMs,
      ),
    {
      message:
        "savedAtMs needs one time per item, each within savedFromMs and savedToMs",
    },
  );

export type CueAuthoredDraftsResponse = Awaited<ReturnType<typeof getData>>;

/**
 * `?items=threadId:messageId,...` names the drafts the lane would show, each
 * by its conversation and its message (split at the last `:`), and
 * `savedAtMs=...` when each was saved, in the same order; `savedFromMs` and
 * `savedToMs` bound those times. Answers which of those messages are drafts
 * Cue wrote into the mailbox. If any of Cue's drafts there can't be read,
 * or there are more to read than one request may, the request fails rather
 * than answer for some of them.
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
      savedFromMs: searchParams.get("savedFromMs") ?? undefined,
      savedToMs: searchParams.get("savedToMs") ?? undefined,
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
  savedToMs,
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
      select: { draftId: true, content: true },
      take: MAX_DRAFT_READS + 1,
    }),
    prisma.threadTracker.findMany({
      where: {
        emailAccountId,
        threadId: { in: threadIds },
        followUpDraftId: byMessageId,
      },
      select: { followUpDraftId: true },
      take: MAX_DRAFT_READS + 1,
    }),
    prisma.meeting.findMany({
      where: draftIdIsMessageId
        ? { emailAccountId, followUpDraftId: byMessageId }
        : {
            emailAccountId,
            followUpDraftId: { not: null },
            // Never written before the meeting; lets the account's
            // (emailAccountId, startTime) index bound the read.
            startTime: {
              lte: new Date(savedToMs + MEETING_DRAFT_SAVE_SLACK_MS),
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

  // The text Cue wrote, where a changed one makes the draft the user's;
  // null where there's none to compare and the draft stays Cue's.
  const candidates = new Map<string, string | null>();
  for (const { draftId, content } of ruleDrafts)
    if (draftId) candidates.set(draftId, content || null);
  for (const { followUpDraftId } of [...followUps, ...meetings])
    if (followUpDraftId) candidates.set(followUpDraftId, null);

  const cueAuthored = new Set<string>();
  const toRead: [string, string][] = [];
  for (const [draftId, originalContent] of candidates) {
    if (draftIdIsMessageId) {
      if (!messageIds.has(draftId)) continue;
      if (originalContent === null) cueAuthored.add(draftId);
      else toRead.push([draftId, originalContent]);
    } else {
      toRead.push([draftId, originalContent ?? ""]);
    }
  }

  // A lookup cut short may have left out one of Cue's drafts.
  if (
    ruleDrafts.length > MAX_DRAFT_READS ||
    followUps.length > MAX_DRAFT_READS ||
    meetings.length > MAX_MEETING_READS ||
    toRead.length > MAX_DRAFT_READS
  ) {
    logger.warn("Too many Cue drafts to check for the drafts lane", {
      ruleDrafts: ruleDrafts.length,
      followUps: followUps.length,
      meetings: meetings.length,
      toRead: toRead.length,
    });
    throw new SafeError("Too many of Cue's drafts to check", 503);
  }

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

  return { messageIds: [...cueAuthored] };
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
