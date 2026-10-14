import { isAutomatedAddress } from "@cue/context";
import { mapWithConcurrency } from "@/utils/async";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import {
  extractEmailAddress,
  extractNameFromEmail,
  isSameEmailAddress,
  splitRecipientList,
} from "@/utils/email";
import type { EmailProvider } from "@/utils/email/types";
import {
  aiExtractInsight,
  type EmailInsight,
} from "@/utils/inbox-insights/extract-insight";
import type { Logger } from "@/utils/logger";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { redis } from "@/utils/redis";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import {
  getCachedSuggestedReply,
  getSuggestedReplySettings,
  type SuggestedReply,
} from "@/utils/thread-context/suggest-reply";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

// Each new email costs one provider read and one small model call, once:
// the result is cached for as long as the email could still be on screen.
const MAX_NEW_PER_REQUEST = 25;
const EXTRACT_CONCURRENCY = 4;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const NO_AI_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MEETING_WINDOW_DAYS = 14;
const SKIP_LABELS = ["SPAM", "TRASH", "DRAFT"];

type CachedMessage = {
  insight: EmailInsight | null;
  /** Other people on the message, for matching meetings with them. */
  people: { email: string; name: string }[];
};

export type ThreadInsightData = {
  insight: EmailInsight | null;
  meeting: { title: string; at: string; with: string; url?: string } | null;
  /** The evidence-checked reply for the latest message, once Cue has tried one. */
  reply: "ready" | "needs-info" | null;
};

/**
 * What Cue adds under each inbox row: what the latest email asks, the meeting
 * coming up with the people on it, and whether an evidence-checked reply is
 * waiting. Keyed by the latest message, so a new message gets a fresh look.
 */
export async function getInboxInsights({
  emailAccountId,
  userEmail,
  items,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  items: { threadId: string; messageId: string }[];
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<{ insights: Record<string, ThreadInsightData> }> {
  const cached = await Promise.all(
    items.map((item) =>
      redis
        .get<CachedMessage>(cacheKey(emailAccountId, item.messageId))
        .catch(() => null),
    ),
  );
  const missing = items
    .filter((_, i) => !cached[i])
    .slice(0, MAX_NEW_PER_REQUEST);

  const fresh = missing.length
    ? await extractMissing({
        emailAccountId,
        userEmail,
        items: missing,
        emailProvider,
        logger,
        now,
      })
    : new Map<string, CachedMessage>();

  const byThread = new Map(
    items.map((item, i) => [
      item.threadId,
      cached[i] ?? fresh.get(item.messageId) ?? null,
    ]),
  );

  const [events, replies] = await Promise.all([
    [...byThread.values()].some((m) => m?.people.length)
      ? upcomingEvents({ emailAccountId, now, logger })
      : [],
    // The same answer the reader shows: a reply Cue verified, maybe saved
    // as a draft, reads "Draft ready" here too.
    getSuggestedReplySettings(emailAccountId).then((settings) =>
      Promise.all(
        items.map((item) =>
          getCachedSuggestedReply(
            {
              emailAccountId,
              threadId: item.threadId,
              messageId: item.messageId,
            },
            settings,
          )
            .then((s) => replyState(s))
            .catch(() => null),
        ),
      ),
    ),
  ]);

  return {
    insights: Object.fromEntries(
      items.map((item, i) => {
        const message = byThread.get(item.threadId);
        return [
          item.threadId,
          {
            insight: message?.insight ?? null,
            meeting: nextMeetingWith(message?.people ?? [], events),
            reply: replies[i] ?? null,
          },
        ];
      }),
    ),
  };
}

async function extractMissing({
  emailAccountId,
  userEmail,
  items,
  emailProvider,
  logger,
  now,
}: {
  emailAccountId: string;
  userEmail: string;
  items: { threadId: string; messageId: string }[];
  emailProvider: EmailProvider;
  logger: Logger;
  now: Date;
}) {
  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  const hasAi = emailAccount
    ? await assertHasAiAccess({
        userId: emailAccount.userId,
        hasUserApiKey: !!emailAccount.user.aiApiKey,
      })
        .then(() => true)
        .catch(() => false)
    : false;
  const aiAccount = hasAi ? emailAccount : null;

  let deferred: unknown = null;
  const results = await mapWithConcurrency(
    items,
    EXTRACT_CONCURRENCY,
    async ({ messageId }) => {
      try {
        const message = await emailProvider.getMessage(messageId);
        const needsLook =
          !isSameEmailAddress(message.headers.from, userEmail) &&
          !message.labelIds?.some((l) => SKIP_LABELS.includes(l));
        const entry: CachedMessage = {
          insight:
            aiAccount && needsLook
              ? await aiExtractInsight({
                  emailAccount: aiAccount,
                  message,
                  timezone: aiAccount.timezone,
                  now,
                })
              : null,
          people: peopleOn(message, userEmail),
        };
        // Without AI access, check back tomorrow rather than for a month.
        await redis
          .set(cacheKey(emailAccountId, messageId), entry, {
            ex: hasAi ? CACHE_TTL_SECONDS : NO_AI_CACHE_TTL_SECONDS,
          })
          .catch(() => null);
        return [messageId, entry] as const;
      } catch (error) {
        if (isGmailCallDeferredError(error)) {
          deferred ??= error;
          return null;
        }
        logger.warn("Failed to build inbox insight", { error });
        return null;
      }
    },
  );
  // Insights wait for spare Gmail quota. Failing the request lets the client
  // retry; what was built is cached, so the retry only reads what is missing.
  if (deferred) throw deferred;
  return new Map(results.filter((r) => r !== null));
}

async function upcomingEvents({
  emailAccountId,
  now,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  logger: Logger;
}): Promise<CalendarEvent[]> {
  return fetchCalendarEventsInWindow({
    emailAccountId,
    timeMin: now,
    timeMax: new Date(now.getTime() + MEETING_WINDOW_DAYS * 86_400_000),
    maxResultsPerProvider: 100,
    logger,
  })
    .then((r) => r.events)
    .catch((error) => {
      logger.warn("Failed to fetch calendar events for insights", { error });
      return [];
    });
}

/** The soonest meeting that someone on the email is also invited to. */
export function nextMeetingWith(
  people: CachedMessage["people"],
  events: CalendarEvent[],
): ThreadInsightData["meeting"] {
  if (!people.length) return null;
  const byEmail = new Map(people.map((p) => [p.email, p]));
  let best: ThreadInsightData["meeting"] = null;
  for (const event of events) {
    const match = event.attendees
      .filter((a) => !a.declined)
      .map((a) => byEmail.get(a.email.toLowerCase()))
      .find(Boolean);
    if (!match) continue;
    const at = event.startTime.toISOString();
    if (!best || at < best.at) {
      best = {
        title: event.title,
        at,
        with: match.name || match.email,
        url: event.eventUrl,
      };
    }
  }
  return best;
}

function peopleOn(message: ParsedMessage, userEmail: string) {
  const raw = [
    message.headers.from,
    ...splitRecipientList(message.headers.to ?? ""),
    ...splitRecipientList(message.headers.cc ?? ""),
  ];
  const people = new Map<string, { email: string; name: string }>();
  for (const r of raw) {
    const email = extractEmailAddress(r).toLowerCase();
    if (
      !email ||
      isSameEmailAddress(email, userEmail) ||
      isAutomatedAddress(email)
    )
      continue;
    if (!people.has(email))
      people.set(email, { email, name: extractNameFromEmail(r) || "" });
  }
  return [...people.values()];
}

function cacheKey(emailAccountId: string, messageId: string) {
  return `inbox-insight:${emailAccountId}:${messageId}`;
}

function replyState(
  suggestion: SuggestedReply | null,
): ThreadInsightData["reply"] {
  if (suggestion?.status === "suggested") return "ready";
  if (suggestion?.status === "insufficient") return "needs-info";
  return null;
}
