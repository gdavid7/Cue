// Rank items related to an open email thread.
//
// 1. Structure first: build a small graph that links each candidate (another
//    email thread, a calendar event, a file) to the people and organizations on
//    it, then walk outward from the people on the open thread. A candidate
//    reached in one hop shares a person with the thread. Two hops means it
//    shares a person with something that does.
// 2. Then similarity: score every candidate on shared rare words (TF-IDF),
//    recency, and how strongly the graph connects it, and keep the best few.
//
// Pure functions only: the caller fetches the candidates.

import { Corpus, tokenize } from "./text";

export type Person = { email: string; name?: string };

export type CandidateKind = "email" | "event";

export type ContextCandidate = {
  id: string;
  kind: CandidateKind;
  title: string;
  text: string;
  /** A short preview for display. Ranking reads `text`. */
  snippet?: string;
  /** ISO time: when the email was sent or the event starts. */
  at: string;
  people: Person[];
  url?: string;
};

export type FocusThread = {
  id: string;
  subject: string;
  text: string;
  at: string;
  people: Person[];
};

export type ContextReason =
  | { type: "person"; label: string }
  | { type: "organization"; label: string }
  | { type: "via"; label: string }
  | { type: "topic"; terms: string[] }
  | { type: "upcoming"; days: number };

export type RankedContext = {
  candidate: ContextCandidate;
  score: number;
  reasons: ContextReason[];
};

export type RankOptions = {
  focus: FocusThread;
  candidates: ContextCandidate[];
  /** The user's own addresses. They're on every thread, so they link nothing. */
  selfEmails: string[];
  now: string;
  limit?: number;
  /** Keeps one kind from crowding out the rest. */
  maxPerKind?: number;
};

const WEIGHTS = { similarity: 0.4, structure: 0.3, recency: 0.2, kind: 0.1 };
const KIND_PRIOR: Record<CandidateKind, number> = { event: 0.8, email: 0.6 };
const MIN_SCORE = 0.18;
const MIN_TOPIC_SIMILARITY = 0.12;
const MAX_PER_KIND = 3;

const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|updates|news(letter)?|digest|billing|receipts?|invoices?|mailer-daemon|postmaster|calendar-notification|support|info|hello|team)([+._-].*)?$/i;

const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

export function rankContext({
  focus,
  candidates,
  selfEmails,
  now,
  limit = 4,
  maxPerKind = MAX_PER_KIND,
}: RankOptions): RankedContext[] {
  const self = new Set(selfEmails.map(normalizeEmail));
  const selfOrgs = new Set([...self].map(orgOf).filter(isString));
  const others = (people: Person[]) =>
    uniqueBy(
      people.filter((p) => !self.has(normalizeEmail(p.email))),
      (p) => normalizeEmail(p.email),
    );

  const focusPeople = others(focus.people);
  const focusEmails = new Set(focusPeople.map((p) => normalizeEmail(p.email)));
  // An organization links things only when it's someone else's; your own
  // employer is on everything, like you are.
  const focusOrgs = new Set(
    focusPeople
      .map((p) => orgOf(normalizeEmail(p.email)))
      .filter((o): o is string => !!o && !selfOrgs.has(o)),
  );

  const pool = candidates.filter((c) => c.id !== focus.id);
  const corpus = new Corpus([
    textOf(focus.subject, focus.text),
    ...pool.map((c) => textOf(c.title, c.text)),
  ]);
  const focusText = textOf(focus.subject, focus.text);

  // Hop 1: candidates that share a person or an organization with the thread.
  const links = new Map<
    string,
    { structure: number; reasons: ContextReason[] }
  >();
  for (const c of pool) {
    const people = others(c.people);
    const shared = people.filter((p) =>
      focusEmails.has(normalizeEmail(p.email)),
    );
    if (shared.length) {
      links.set(c.id, {
        structure: 1,
        reasons: shared
          .slice(0, 2)
          .map((p) => ({ type: "person", label: displayName(p) })),
      });
      continue;
    }
    const org = people
      .map((p) => orgOf(normalizeEmail(p.email)))
      .find((o) => o && focusOrgs.has(o));
    if (org)
      links.set(c.id, {
        structure: 0.6,
        reasons: [{ type: "organization", label: org }],
      });
  }

  // Hop 2: candidates that share a person with a hop-1 candidate. These are
  // the colleague who was cc'd last time, or the meeting they set up.
  const bridges = new Map<string, Person>();
  for (const c of pool) {
    if (links.get(c.id)?.structure !== 1) continue;
    for (const p of others(c.people)) {
      const email = normalizeEmail(p.email);
      if (!focusEmails.has(email) && !bridges.has(email)) bridges.set(email, p);
    }
  }
  for (const c of pool) {
    if (links.has(c.id)) continue;
    const via = others(c.people).find((p) =>
      bridges.has(normalizeEmail(p.email)),
    );
    if (via)
      links.set(c.id, {
        structure: 0.4,
        reasons: [{ type: "via", label: displayName(via) }],
      });
  }

  const scored: RankedContext[] = [];
  for (const c of pool) {
    const link = links.get(c.id);
    const sim = corpus.similarity(focusText, textOf(c.title, c.text));
    // Unlinked candidates must at least be about the same thing.
    if (!link && sim.score < MIN_TOPIC_SIMILARITY) continue;

    const days = daysBetween(now, c.at);
    const score =
      WEIGHTS.similarity * sim.score +
      WEIGHTS.structure * (link?.structure ?? 0) +
      WEIGHTS.recency * recency(c.kind, days) +
      WEIGHTS.kind * KIND_PRIOR[c.kind];

    const reasons: ContextReason[] = [...(link?.reasons ?? [])];
    if (sim.score >= MIN_TOPIC_SIMILARITY && sim.terms.length) {
      reasons.push({ type: "topic", terms: sim.terms.slice(0, 3) });
    }
    if (c.kind === "event" && days >= 0 && days <= 14) {
      reasons.push({ type: "upcoming", days: Math.floor(days) });
    }
    scored.push({ candidate: c, score: round(score), reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const perKind = new Map<CandidateKind, number>();
  const picked: RankedContext[] = [];
  for (const r of scored) {
    // Two strong items beat two strong items plus two weak ones.
    if (r.score < Math.max(MIN_SCORE, top * 0.5)) break;
    const count = perKind.get(r.candidate.kind) ?? 0;
    if (count >= maxPerKind) continue;
    perKind.set(r.candidate.kind, count + 1);
    picked.push(r);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Distinctive words of a thread, for finding related items by topic when no
 * person links them: subject words first, then the body's most frequent words.
 */
export function focusKeywords(
  focus: Pick<FocusThread, "subject" | "text">,
  limit = 4,
): string[] {
  const subject = tokenize(focus.subject).filter(isKeyword);
  const counts = new Map<string, number>();
  for (const t of tokenize(focus.text).filter(isKeyword)) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const body = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  return [...new Set([...subject, ...body])].slice(0, limit);
}

/**
 * Organization implied by an email's domain. Consumer mail domains imply none,
 * and neither do automated senders: notifications from github.com don't make
 * every GitHub email related.
 */
export function orgOf(email: string): string | null {
  const domain = email.split("@")[1];
  if (!domain || CONSUMER_DOMAINS.has(domain) || isAutomatedAddress(email)) {
    return null;
  }
  return domain;
}

/** Addresses a machine sends from: no-reply, notifications, billing, lists. */
export function isAutomatedAddress(email: string): boolean {
  return AUTOMATED_LOCAL_PART.test(email.split("@")[0] ?? "");
}

function recency(kind: CandidateKind, days: number): number {
  // An upcoming meeting is most useful just before it happens.
  if (kind === "event" && days >= 0) return Math.exp(-days / 14);
  return Math.exp(-Math.abs(days) / 45);
}

function isKeyword(t: string) {
  return t.length >= 4 && !/^\d+$/.test(t);
}

function textOf(title: string, text: string) {
  return `${title} ${title} ${text}`; // the title says what it's about, so count it twice
}

function displayName(p: Person) {
  return p.name?.trim() || p.email;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function daysBetween(from: string, to: string) {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

function round(x: number) {
  return Math.round(x * 1000) / 1000;
}

function isString(x: string | null): x is string {
  return typeof x === "string";
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
