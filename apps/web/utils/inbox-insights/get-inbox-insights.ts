import { isAutomatedAddress } from "@cue/context";
import { mapWithConcurrency } from "@/utils/async";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
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
import {
  type InsightEvent,
  type InsightPerson,
  type ThreadMeeting,
  toInsightEvent,
} from "@/utils/inbox-insights/meeting-match";
import type { Logger } from "@/utils/logger";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { getSuggestedReplySettings } from "@/utils/thread-context/suggest-reply";
import { canWriteRequestedReplies } from "@/utils/rule/draft-replies-enabled";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

// Each new email costs one provider read and one small model call, once per
// browser: the browser keeps what it was given (RD-3), and names the
// messages it already holds so they aren't read again.
const MAX_NEW_PER_REQUEST = 25;
const EXTRACT_CONCURRENCY = 4;
const MEETING_WINDOW_DAYS = 14;
// Only a request with uncached emails is charged, and it can make up to
// MAX_NEW_PER_REQUEST model calls, so this sits below the per-call limits.
const NEW_INSIGHT_REQUESTS_PER_WINDOW = 30;
const RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const SKIP_LABELS = ["SPAM", "TRASH", "DRAFT"];
// Kept by the browser with each insight for a month; a mailing's full
// recipient list would make one entry many kilobytes for meetings it can't
// usefully match.
const MAX_PEOPLE = 25;

/** What Cue read from one email, for the browser to keep. */
export type InboxInsightExtraction = {
  messageId: string;
  insight: EmailInsight | null;
  /** Other people on the message, for matching meetings with them. */
  people: InsightPerson[];
  /** False when the account had no AI access: worth asking again later. */
  withAi: boolean;
};

export type ThreadInsightData = {
  insight: EmailInsight | null;
  meeting: ThreadMeeting | null;
  /** The evidence-checked reply for the latest message, once Cue has tried one. */
  reply: "ready" | "needs-info" | null;
};

/**
 * What Cue adds under each inbox row, read fresh for the emails the browser
 * doesn't hold yet: what the latest email asks and who is on it. With the
 * upcoming meetings, so the browser can show the one with those people.
 * Nothing is cached here (RD-3).
 */
export async function getInboxInsights({
  emailAccountId,
  userId,
  userEmail,
  items,
  known = [],
  withEvents = false,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userId: string;
  userEmail: string;
  items: { threadId: string; messageId: string }[];
  /** Messages the browser already holds an insight for. */
  known?: string[];
  /** The browser holds people to match against meetings. */
  withEvents?: boolean;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<{
  insights: Record<string, InboxInsightExtraction>;
  events: InsightEvent[];
  draftRepliesEnabled: boolean;
}> {
  const knownIds = new Set(known);
  const missing = items
    .filter((item) => !knownIds.has(item.messageId))
    .slice(0, MAX_NEW_PER_REQUEST);

  // A page the browser already holds costs no model call and is not charged.
  if (missing.length) {
    await assertWithinUserRateLimit({
      scope: "inbox-insights",
      userId,
      limit: NEW_INSIGHT_REQUESTS_PER_WINDOW,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      logger,
    });
  }

  const fresh = missing.length
    ? await extractMissing({
        emailAccountId,
        userEmail,
        items: missing,
        emailProvider,
        logger,
        now,
      })
    : new Map<string, InboxInsightExtraction>();

  const needsEvents =
    withEvents || [...fresh.values()].some((entry) => entry.people.length);
  const [events, settings] = await Promise.all([
    needsEvents ? upcomingEvents({ emailAccountId, now, logger }) : [],
    getSuggestedReplySettings(emailAccountId),
  ]);

  return {
    insights: Object.fromEntries(
      items.flatMap((item) => {
        const entry = fresh.get(item.messageId);
        return entry ? [[item.threadId, entry]] : [];
      }),
    ),
    events: events.map(toInsightEvent),
    // A suggestion this browser kept shows as "Draft ready" only while
    // drafting is on.
    draftRepliesEnabled: canWriteRequestedReplies(settings.draftReplies),
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
        const entry: InboxInsightExtraction = {
          messageId,
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
          withAi: hasAi,
        };
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
  // Insights wait for spare Gmail quota. With nothing built, failing the
  // request lets the client retry; what was built goes back so the browser
  // keeps it, and the rest is asked for when the rows next change.
  if (deferred && !results.some(Boolean)) throw deferred;
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
}) {
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
    if (people.size >= MAX_PEOPLE) break;
  }
  return [...people.values()];
}
