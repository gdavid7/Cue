import {
  type ContextCandidate,
  type ContextReason,
  type FocusThread,
  focusKeywords,
  isAutomatedAddress,
  type Person,
  rankContext,
} from "@cue/context";
import { mapWithConcurrency } from "@/utils/async";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import {
  extractEmailAddress,
  extractNameFromEmail,
  isSameEmailAddress,
  splitRecipientList,
} from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { parseReply } from "@/utils/mail";
import { fetchConnectorCandidates } from "@/utils/thread-context/connector-context";
import { fetchLinkedPages } from "@/utils/thread-context/linked-pages";
import type { ParsedMessage } from "@/utils/types";

// Each thread open costs about 1 + 3 × 2 + 1 provider calls, so keep the
// fan-out small: the panel shows four items at most.
const MAX_PARTICIPANTS = 3;
const THREADS_PER_PARTICIPANT = 3;
const PARTICIPANT_CONCURRENCY = 2;
const TOPIC_THREADS = 10;
const TOPIC_KEYWORDS = 6;
const CALENDAR_WINDOW_DAYS = 30;
const MAX_MESSAGE_TEXT = 600;
const SNIPPET_LENGTH = 180;
// Suggested replies are checked against these same items, so a short list
// hides evidence the reply needs; the ranker still drops weak matches.
const CONTEXT_LIMIT = 8;

export type ThreadContextItem = {
  /** For emails, the thread id, so the panel can open that conversation. */
  id: string;
  kind: ContextCandidate["kind"];
  title: string;
  snippet: string;
  at: string;
  url?: string;
  /** The app it came from, for items that aren't email or calendar. */
  source?: string;
  reasons: ContextReason[];
};

/**
 * Finds the few items elsewhere in the user's mailbox and calendar that matter
 * for this thread: other conversations with the same people or about the same
 * thing, and meetings with them. Every source is optional; one failing only
 * means fewer items.
 */
export async function getThreadContext({
  emailAccountId,
  userEmail,
  threadId,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  threadId: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<{ items: ThreadContextItem[] }> {
  const { items } = await collectThreadContext({
    emailAccountId,
    userEmail,
    threadId,
    emailProvider,
    logger,
    now,
  });
  return { items: items.map(({ text: _text, ...item }) => item) };
}

/**
 * The thread itself and its ranked context, with the text each item was
 * ranked on, for features that reason over the evidence rather than show it.
 */
export async function collectThreadContext({
  emailAccountId,
  userEmail,
  threadId,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  threadId: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<{
  thread: EmailThread | null;
  items: (ThreadContextItem & { text: string })[];
}> {
  // The reader can hold a thread the provider hasn't synced yet.
  const thread = await emailProvider.getThread(threadId).catch((error) => {
    logger.warn("Failed to load thread for context", { error });
    return null;
  });
  if (!thread?.messages.length) return { thread: null, items: [] };

  const focus = toFocus(thread);
  const participants = focus.people
    .filter(
      (p) =>
        !isSameEmailAddress(p.email, userEmail) && !isAutomatedAddress(p.email),
    )
    .slice(0, MAX_PARTICIPANTS);

  const [peopleThreads, topicThreads, events, connectorItems, linkedPages] =
    await Promise.all([
      mapWithConcurrency(participants, PARTICIPANT_CONCURRENCY, (p) =>
        emailProvider
          .getThreadsWithParticipant({
            participantEmail: p.email,
            maxThreads: THREADS_PER_PARTICIPANT,
          })
          .catch((error) => {
            logger.warn("Failed to fetch threads with participant", { error });
            return [];
          }),
      ),
      findTopicThreads({ focus, emailProvider, logger }),
      fetchCalendarEventsInWindow({
        emailAccountId,
        timeMin: addDays(now, -CALENDAR_WINDOW_DAYS),
        timeMax: addDays(now, CALENDAR_WINDOW_DAYS),
        maxResultsPerProvider: 50,
        logger,
      })
        .then((result) => result.events)
        .catch((error) => {
          logger.warn("Failed to fetch calendar events for context", { error });
          return [];
        }),
      fetchConnectorCandidates({
        emailAccountId,
        keywords: focusKeywords(focus, TOPIC_KEYWORDS),
        logger,
        now,
      }),
      fetchLinkedPages({ message: thread.messages.at(-1)!, logger }),
    ]);

  const otherThreads = uniqueById([
    ...peopleThreads.flat(),
    ...topicThreads,
  ]).filter((t) => t.id !== thread.id);

  const ranked = rankContext({
    focus,
    candidates: [
      ...otherThreads.map(threadToCandidate),
      ...events.map(eventToCandidate),
      ...connectorItems,
      ...linkedPages,
    ],
    selfEmails: [userEmail],
    now: now.toISOString(),
    limit: CONTEXT_LIMIT,
  });

  return {
    thread,
    items: ranked.map(({ candidate, reasons }) => ({
      id: candidate.id,
      kind: candidate.kind,
      title: candidate.title,
      snippet: truncate(candidate.snippet ?? candidate.text, SNIPPET_LENGTH),
      text: candidate.text,
      at: candidate.at,
      url: candidate.url,
      source: candidate.source,
      reasons,
    })),
  };
}

async function findTopicThreads({
  focus,
  emailProvider,
  logger,
}: {
  focus: FocusThread;
  emailProvider: EmailProvider;
  logger: Logger;
}): Promise<EmailThread[]> {
  const keywords = focusKeywords(focus, TOPIC_KEYWORDS);
  if (!keywords.length) return [];
  try {
    const { threads } = await emailProvider.searchThreads({
      query: keywords.join(" OR "),
      maxResults: TOPIC_THREADS,
      // Headers and snippets are enough to rank, and much cheaper than bodies.
      messageFormat: "metadata",
    });
    return threads;
  } catch (error) {
    logger.warn("Failed to search threads by topic", { error });
    return [];
  }
}

function toFocus(thread: EmailThread): FocusThread {
  const latest = thread.messages.at(-1)!;
  return {
    id: thread.id,
    subject: latest.headers.subject || latest.subject,
    text: threadText(thread.messages),
    at: messageTime(latest),
    people: peopleOf(thread.messages),
  };
}

export function threadToCandidate(
  thread: EmailThread,
): ContextCandidate & { snippet?: string } {
  const latest = thread.messages.at(-1);
  return {
    id: thread.id,
    kind: "email",
    title:
      latest?.headers.subject ||
      latest?.subject ||
      thread.snippet ||
      "(no subject)",
    text: threadText(thread.messages) || thread.snippet,
    snippet: latest?.snippet || thread.snippet,
    at: latest ? messageTime(latest) : new Date(0).toISOString(),
    people: peopleOf(thread.messages),
  };
}

export function eventToCandidate(event: CalendarEvent): ContextCandidate {
  return {
    id: `event:${event.id}`,
    kind: "event",
    title: event.title,
    // Google event descriptions can contain HTML.
    text: [event.description?.replace(/<[^>]+>/g, " "), event.location]
      .filter(Boolean)
      .join(" "),
    at: event.startTime.toISOString(),
    people: event.attendees
      .filter((a) => !a.declined)
      .map((a) => ({ email: a.email, name: a.name })),
    url: event.eventUrl,
  };
}

/** Senders first (latest first), then recipients: who wrote matters most. */
function peopleOf(messages: ParsedMessage[]): Person[] {
  const people = new Map<string, Person>();
  const add = (raw: string) => {
    const email = extractEmailAddress(raw).toLowerCase();
    if (!email || people.has(email)) return;
    people.set(email, { email, name: extractNameFromEmail(raw) || undefined });
  };
  for (const m of [...messages].reverse()) add(m.headers.from);
  for (const m of messages) {
    for (const raw of [
      ...splitRecipientList(m.headers.to),
      ...splitRecipientList(m.headers.cc ?? ""),
    ]) {
      add(raw);
    }
  }
  return [...people.values()];
}

/**
 * What each message says in its own words: quoted history and signatures are
 * dropped, and each message is capped, so one long reply chain can't dominate.
 */
function threadText(messages: ParsedMessage[]) {
  return messages
    .map((m) =>
      (m.textPlain ? parseReply(m.textPlain) : m.snippet || "")
        .trim()
        .slice(0, MAX_MESSAGE_TEXT),
    )
    .join("\n");
}

function messageTime(m: ParsedMessage) {
  return new Date(getMessageTimestamp(m)).toISOString();
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

export function truncate(text: string, length: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}
