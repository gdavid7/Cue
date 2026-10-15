import {
  type ContextCandidate,
  isAutomatedAddress,
  orgOf,
  type Person,
  rankContext,
} from "@cue/context";
import { mapWithConcurrency } from "@/utils/async";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { isSameEmailAddress } from "@/utils/email";
import { describeProviderRateLimitError } from "@/utils/email/rate-limit";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  eventToCandidate,
  threadSignals,
  threadToCandidate,
  truncate,
} from "@/utils/thread-context/get-thread-context";
import { fetchConnectorCandidates } from "@/utils/thread-context/connector-context";
import { reasonLabel } from "@/utils/thread-context/reason-label";

const MAX_TERMS = 6;
const SEARCH_THREADS = 15;
const MAX_PEOPLE = 2;
const THREADS_PER_PERSON = 5;
const CALENDAR_WINDOW_DAYS = 60;
const RESULT_LIMIT = 8;
const MAX_PER_KIND = 6;
const SNIPPET_LENGTH = 240;

export type ContextSearchResult = {
  /** Thread id for emails, `event:<id>` for meetings. */
  id: string;
  kind: ContextCandidate["kind"];
  title: string;
  snippet: string;
  at: string;
  /** Latest message in the thread, to read it in full. */
  messageId?: string;
  from?: string;
  url?: string;
  /** The app it came from, e.g. "Google Drive" or a Canvas course. */
  source?: string;
  why: string[];
};

/**
 * Answers "what do I have about X" across email and calendar. Matches the words
 * first, then follows the graph: when a word names someone (a first name, an
 * organization's domain) on a matching email, their other conversations and
 * meetings count too, so "Acme" also finds the thread with Acme's CFO.
 */
export async function searchContext({
  emailAccountId,
  userEmail,
  query,
  threadId,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  query: string;
  /**
   * The thread the question is about: what it links to and its sender's
   * record in connected apps count too, as in its Relevant context.
   */
  threadId?: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<{ results: ContextSearchResult[] }> {
  const terms = queryTerms(query);
  if (!terms.length) return { results: [] };

  const thread = threadId
    ? await emailProvider.getThread(threadId).catch((error) => {
        if (describeProviderRateLimitError(error, emailProvider.name))
          throw error;
        // The provider's error can quote the thread; it goes to trace only.
        logger.warn("Failed to load thread for context search", {
          reason: error instanceof Error ? error.name : typeof error,
        });
        logger.trace("Thread for context search failed to load", { error });
        return null;
      })
    : null;
  const signals = thread ? threadSignals(thread, userEmail) : undefined;

  const startedAt = Date.now();
  const timing = {
    emailMs: 0,
    calendarMs: 0,
    connectorsMs: 0,
    participantsMs: 0,
  };
  let emailFailed = false;
  let calendarFailed = false;
  const [hits, events, connectors] = await Promise.all([
    searchEmailThreads(emailProvider, terms)
      .catch((error) => {
        // Empty results would read as "nothing about this"; a limited mailbox
        // has to be reported so the assistant can say to try again.
        if (describeProviderRateLimitError(error, emailProvider.name))
          throw error;
        logger.warn("Context search failed", { error });
        emailFailed = true;
        return [] as EmailThread[];
      })
      .finally(() => {
        timing.emailMs = Date.now() - startedAt;
      }),
    fetchCalendarEventsInWindow({
      emailAccountId,
      timeMin: addDays(now, -CALENDAR_WINDOW_DAYS),
      timeMax: addDays(now, CALENDAR_WINDOW_DAYS),
      maxResultsPerProvider: 100,
      logger,
    })
      .then((r) => r.events)
      .catch((error) => {
        logger.warn("Failed to fetch calendar events for search", { error });
        calendarFailed = true;
        return [];
      })
      .finally(() => {
        timing.calendarMs = Date.now() - startedAt;
      }),
    fetchConnectorCandidates({
      emailAccountId,
      keywords: terms,
      signals,
      logger,
      now,
    }).finally(() => {
      timing.connectorsMs = Date.now() - startedAt;
    }),
  ]);

  const hitCandidates = hits.map(threadToCandidate);
  const people = namedPeople({
    terms,
    candidates: [...hitCandidates, ...events.map(eventToCandidate)],
    userEmail,
  });
  const participantsStartedAt = Date.now();
  const theirThreads = await mapWithConcurrency(people, MAX_PEOPLE, (p) =>
    emailProvider
      .getThreadsWithParticipant({
        participantEmail: p.email,
        maxThreads: THREADS_PER_PERSON,
      })
      .catch((error) => {
        logger.warn("Failed to fetch threads with participant", { error });
        return [] as EmailThread[];
      }),
  );

  timing.participantsMs = Date.now() - participantsStartedAt;

  const threads = new Map(
    [...hits, ...theirThreads.flat()].map((t) => [t.id, t]),
  );
  const ranked = rankContext({
    focus: {
      id: "search",
      subject: query,
      text: query,
      at: now.toISOString(),
      // The thread's sender is who the question is about, which is what
      // links their record in a connected app.
      people: signals?.senderEmail
        ? [...people, { email: signals.senderEmail }]
        : people,
    },
    candidates: [
      ...[...threads.values()].map(threadToCandidate),
      ...events.map(eventToCandidate),
      ...connectors.candidates,
    ],
    selfEmails: [userEmail],
    now: now.toISOString(),
    limit: RESULT_LIMIT,
    maxPerKind: MAX_PER_KIND,
  });

  logger.info("Context search finished", {
    ...timing,
    durationMs: Date.now() - startedAt,
    emailFailed,
    calendarFailed,
    connectorsComplete: connectors.complete,
    emailHits: hits.length,
    eventCount: events.length,
    connectorCount: connectors.candidates.length,
    peopleFollowed: people.length,
    resultCount: ranked.length,
  });

  return {
    results: ranked.map(({ candidate, reasons }) => {
      const latest = threads.get(candidate.id)?.messages.at(-1);
      return {
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        snippet: truncate(candidate.snippet ?? candidate.text, SNIPPET_LENGTH),
        at: candidate.at,
        messageId: latest?.id,
        from: latest?.headers.from,
        url: candidate.url,
        source: candidate.source,
        why: reasons.map(reasonLabel),
      };
    }),
  };
}

/**
 * People a search word names: "nora" names Nora Patel, "acme" names everyone
 * at acme.com. Only people already on a matching email or meeting, so a common
 * word can't pull in strangers.
 */
export function namedPeople({
  terms,
  candidates,
  userEmail,
}: {
  terms: string[];
  candidates: Pick<ContextCandidate, "people">[];
  userEmail: string;
}): Person[] {
  const wanted = new Set(terms);
  const found = new Map<string, Person>();
  for (const person of candidates.flatMap((c) => c.people)) {
    const email = person.email.toLowerCase();
    if (
      found.has(email) ||
      isSameEmailAddress(email, userEmail) ||
      isAutomatedAddress(email)
    ) {
      continue;
    }
    const names = words(person.name ?? "");
    const org = orgOf(email)?.split(".")[0];
    if (names.some((n) => wanted.has(n)) || (org && wanted.has(org))) {
      found.set(email, { ...person, email });
    }
  }
  return [...found.values()].slice(0, MAX_PEOPLE);
}

export function queryTerms(query: string) {
  return [...new Set(words(query).filter((w) => w.length >= 2))].slice(
    0,
    MAX_TERMS,
  );
}

/**
 * Threads with every word first, then any word to fill the page. Mail search
 * returns newest first, so asking for any word alone fills the page with
 * recent mail that only shares a common word and leaves out the older thread
 * that has them all.
 */
async function searchEmailThreads(
  emailProvider: EmailProvider,
  terms: string[],
): Promise<EmailThread[]> {
  const search = (query: string, maxResults: number) =>
    emailProvider
      .searchThreads({ query, maxResults, messageFormat: "metadata" })
      .then((r) => r.threads);
  const all = await search(terms.join(" "), SEARCH_THREADS);
  if (terms.length < 2 || all.length >= SEARCH_THREADS) return all;
  const seen = new Set(all.map((t) => t.id));
  const any = await search(terms.join(" OR "), SEARCH_THREADS - all.length);
  return [...all, ...any.filter((t) => !seen.has(t.id))];
}

function words(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}
