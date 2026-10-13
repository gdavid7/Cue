// Step 4a: what is this email *asking for*?
//
// The intent decides which parts of the graph are worth walking. A scheduling
// email needs the calendar; a document request needs Drive; a decision needs the
// facts behind it. These rules are the offline fallback — when an LLM is
// configured, its classification takes precedence (see agent/claude.ts).

import type { Intent } from "../core/types.ts";

interface Rule {
  intent: Intent;
  pattern: RegExp;
  weight: number;
}

const RULES: Rule[] = [
  { intent: "newsletter", pattern: /unsubscribe|this week's deals|newsletter|% off|sale ends/i, weight: 3 },
  { intent: "receipt", pattern: /\b(delivered|order #|receipt|trip confirmation|confirmation [A-Z0-9]{5,})/i, weight: 3 },
  { intent: "bill", pattern: /amount due|your (\w+ )?bill|statement is ready|autopay/i, weight: 3 },
  { intent: "scheduling", pattern: /reschedul|appointment|can (\w+ )?make it|picture day|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|which day|flying in/i, weight: 2 },
  { intent: "document_request", pattern: /(send|attach|share)( it| it over| over| me)?( the| her| his| your)? [\w\s-]{0,30}(form|file|document|pdf|photos?|quote)|send it over/i, weight: 2 },
  { intent: "decision", pattern: /confirm by|whether you('d| would) like|let us know if you('d| would)|renewal|decide|choose between/i, weight: 2 },
  { intent: "question", pattern: /\?/, weight: 1 },
];

export interface Classification {
  primary: Intent;
  all: Intent[];
}

export function classify(text: string, fromAutomatedSender: boolean): Classification {
  const scores = new Map<Intent, number>();
  for (const r of RULES) {
    if (r.pattern.test(text)) scores.set(r.intent, (scores.get(r.intent) ?? 0) + r.weight);
  }
  // Marketing and receipts come from robots; a human asking "is it on sale?" is a question.
  if (!fromAutomatedSender) {
    scores.delete("newsletter");
    scores.delete("receipt");
  }
  const all = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  return { primary: all[0] ?? "fyi", all: all.length ? all : ["fyi"] };
}

// ---------------------------------------------------------------------------
// Dates mentioned in text, resolved against "now". Used to anchor calendar lookups.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Returns YYYY-MM-DD strings (in UTC calendar terms) for dates the text refers to. */
export function extractDates(text: string, now: string): string[] {
  const base = new Date(now);
  const found = new Set<string>();

  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/gi)) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : base.getUTCFullYear();
    // A year-less date more than ~2 months in the past probably means next year.
    if (!m[3] && Date.UTC(year, month, day) < base.getTime() - 60 * 86_400_000) year++;
    found.add(ymd(new Date(Date.UTC(year, month, day))));
  }

  // Relative weekdays ("this Saturday", "next Tuesday") resolve to the coming such
  // day — but only when no explicit date already pins them down. A bare "Wednesday"
  // is ambiguous ("flying in Wednesday for Thanksgiving" is not *this* Wednesday).
  if (found.size === 0) {
    for (const m of text.matchAll(/\b(?:this|next|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
      const target = WEEKDAYS.indexOf(m[1].toLowerCase());
      const d = new Date(base);
      const delta = (target - d.getUTCDay() + 7) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + delta);
      found.add(ymd(d));
    }
  }
  return [...found].sort();
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
