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
import {
  fetchConnectorCandidates,
  type ThreadSignals,
} from "@/utils/thread-context/connector-context";
import { fetchLinkedPages, linksIn } from "@/utils/thread-context/linked-pages";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import type { ParsedMessage } from "@/utils/types";

// Every related thread is a Gmail threads.get at 40 quota units, so one open
// costs about 40 + 3 × (10 + 3 × 40) + (10 + 5 × 40) = 640 units of the
// account's 6,000 per minute. Keep the fan-out small and cache the result.
const MAX_PARTICIPANTS = 3;
const THREADS_PER_PARTICIPANT = 3;
const PARTICIPANT_CONCURRENCY = 2;
const TOPIC_THREADS = 5;
const TOPIC_KEYWORDS = 6;
const CALENDAR_WINDOW_DAYS = 30;
const MAX_MESSAGE_TEXT = 600;
const SNIPPET_LENGTH = 180;
const SLOW_STEPS_LOG_MS = 1000;
// Suggested replies are checked against these same items, so a short list
// hides evidence the reply needs; the ranker still drops weak matches.
const CONTEXT_LIMIT = 8;
/** The most of each item's text that leaves for the browser and comes back. */
export const CONTEXT_TEXT_LIMIT = 2000;
// The reader panel and the suggested reply both ask for the same thread's
// context. A new message in this thread changes the key, but related threads
// and meetings change too, so the result is kept only for a few minutes.

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
  /** For an item a link in the thread points at: the message the link is in. */
  linkedFrom?: string;
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
}): Promise<{ items: (ThreadContextItem & { text: string })[] }> {
  const { items } = await collectThreadContext({
    emailAccountId,
    userEmail,
    threadId,
    emailProvider,
    logger,
    now,
  });
  // With its text, capped, so the reader can hand the same context to a
  // suggested reply instead of it being gathered again (no server cache).
  return {
    items: items.map((item) => ({
      ...item,
      text: item.text.slice(0, CONTEXT_TEXT_LIMIT),
    })),
  };
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
  knownItems,
}: {
  emailAccountId: string;
  userEmail: string;
  threadId: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
  /** Context the reader already gathered: only the thread is read again. */
  knownItems?: (ThreadContextItem & { text: string })[];
}): Promise<{
  thread: EmailThread | null;
  items: (ThreadContextItem & { text: string })[];
}> {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const timed = <T>(step: string, work: Promise<T>) =>
    work.finally(() => {
      timings[`${step}Ms`] = Date.now() - startedAt;
    });
  // Calendar events don't depend on the thread, so they load while it does.
  const eventsPromise = knownItems
    ? null
    : timed(
        "calendar",
        fetchCalendarEventsInWindow({
          emailAccountId,
          timeMin: addDays(now, -CALENDAR_WINDOW_DAYS),
          timeMax: addDays(now, CALENDAR_WINDOW_DAYS),
          maxResultsPerProvider: 50,
          logger,
        })
          .then((result) => result.events)
          .catch((error) => {
            logger.warn("Failed to fetch calendar events for context", {
              error,
            });
            return [];
          }),
      );
  // The reader can hold a thread the provider hasn't synced yet.
  const thread = await timed("thread", emailProvider.getThread(threadId)).catch(
    (error) => {
      // Context waits for spare Gmail quota rather than caching a partial
      // result; the caller retries.
      if (isGmailCallDeferredError(error)) throw error;
      logger.warn("Failed to load thread for context", { error });
      return null;
    },
  );
  if (!thread?.messages.length) return { thread: null, items: [] };
  if (knownItems) return { thread, items: knownItems };

  const focus = toFocus(thread);
  const participants = focus.people
    .filter(
      (p) =>
        !isSameEmailAddress(p.email, userEmail) && !isAutomatedAddress(p.email),
    )
    .slice(0, MAX_PARTICIPANTS);

  // Each source is optional. Nothing is cached server-side (RD-3): the
  // related mail, events and pages are personal data, so every open asks again.
  const [peopleThreads, topicThreads, events, connectors, linkedPages] =
    await Promise.all([
      timed(
        "people",
        mapWithConcurrency(participants, PARTICIPANT_CONCURRENCY, (p) =>
          emailProvider
            .getThreadsWithParticipant({
              participantEmail: p.email,
              maxThreads: THREADS_PER_PARTICIPANT,
            })
            .catch((error) => {
              if (isGmailCallDeferredError(error)) throw error;
              logger.warn("Failed to fetch threads with participant", {
                error,
              });
              return [];
            }),
        ),
      ),
      timed(
        "topic",
        findTopicThreads({ focus, emailProvider }).catch((error) => {
          if (isGmailCallDeferredError(error)) throw error;
          logger.warn("Failed to search threads by topic", { error });
          return [];
        }),
      ),
      eventsPromise ?? [],
      timed(
        "connectors",
        fetchConnectorCandidates({
          emailAccountId,
          keywords: focusKeywords(focus, TOPIC_KEYWORDS),
          signals: threadSignals(thread, userEmail),
          logger,
          now,
        }),
      ),
      timed(
        "linkedPages",
        fetchLinkedPages({ message: thread.messages.at(-1)!, logger }),
      ),
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
      ...connectors.candidates,
      ...linkedPages.candidates,
    ],
    selfEmails: [userEmail],
    now: now.toISOString(),
    limit: CONTEXT_LIMIT,
  });

  const items = ranked.map(({ candidate, reasons }) => ({
    id: candidate.id,
    kind: candidate.kind,
    title: candidate.title,
    snippet: truncate(candidate.snippet ?? candidate.text, SNIPPET_LENGTH),
    text: candidate.text,
    at: candidate.at,
    url: candidate.url,
    source: candidate.source,
    linkedFrom: candidate.linkedFrom,
    reasons,
  }));
  // When each source finished, from the start: which one the reader waits on.
  const steps = {
    ...timings,
    totalMs: Date.now() - startedAt,
    participantCount: participants.length,
    itemCount: items.length,
  };
  if (steps.totalMs >= SLOW_STEPS_LOG_MS)
    logger.info("Thread context steps", steps);
  else logger.trace("Thread context steps", steps);
  return { thread, items };
}

async function findTopicThreads({
  focus,
  emailProvider,
}: {
  focus: FocusThread;
  emailProvider: EmailProvider;
}): Promise<EmailThread[]> {
  const keywords = focusKeywords(focus, TOPIC_KEYWORDS);
  if (!keywords.length) return [];
  const { threads } = await emailProvider.searchThreads({
    query: keywords.join(" OR "),
    maxResults: TOPIC_THREADS,
    // Headers and snippets are enough to rank, and much cheaper than bodies.
    messageFormat: "metadata",
  });
  return threads;
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

/**
 * Every link in the thread, and the latest person other than the user who
 * wrote in it, so connected apps can show what the thread points at.
 */
export function threadSignals(
  thread: EmailThread,
  userEmail: string,
): ThreadSignals {
  // A link quoted in later replies stays with the message that first sent it.
  const byUrl = new Map<string, ThreadSignals["links"][number]>();
  for (const m of thread.messages) {
    for (const { href } of linksIn(m)) {
      if (!byUrl.has(href)) byUrl.set(href, { url: href, messageId: m.id });
    }
  }
  const links = [...byUrl.values()];
  const sender = latestSenderMessage(thread, userEmail);
  return sender
    ? {
        links,
        senderEmail: extractEmailAddress(sender.headers.from).toLowerCase(),
      }
    : { links };
}

/**
 * The latest message from a person other than the user, whose sender a
 * connected CRM is asked about. Automated senders have no record worth finding.
 */
export function latestSenderMessage(
  thread: EmailThread,
  userEmail: string,
): ParsedMessage | undefined {
  return [...thread.messages].reverse().find((m) => {
    const email = extractEmailAddress(m.headers.from);
    return (
      !!email &&
      !isSameEmailAddress(email, userEmail) &&
      !isAutomatedAddress(email.toLowerCase())
    );
  });
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
