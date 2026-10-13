// Structured facts pulled out of text, each with a validity window.
//
// In production an LLM extractor (e.g. Graphiti's) proposes facts like these
// generically. Here a few regexes cover money facts, which is enough to show the
// important idea: a fact is only true *for a period*, and a newer fact can
// supersede an older one without erasing it.

export interface ExtractedFact {
  key: string; // e.g. "rent", "amount_due", "increase_cap_pct"
  value: number;
  text: string;
  proposed: boolean; // an offer, not (yet) the agreed value
  validFrom?: string;
  validTo?: string;
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DATE = `(?:${MONTHS})[a-z]* \\d{1,2}, \\d{4}`;

const money = (s: string) => Number(s.replace(/,/g, ""));

export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const add = (key: string, value: number, matched: string, proposed = false) =>
    facts.push({ key, value, text: matched.trim(), proposed });

  for (const m of text.matchAll(/(monthly rent|rent)\s*:\s*\$([\d,]+(?:\.\d{2})?)/gi)) add("rent", money(m[2]), m[0]);
  for (const m of text.matchAll(/(?:renewal|offering)[^.$]*?\$([\d,]+(?:\.\d{2})?)\s*\/\s*month/gi)) add("rent", money(m[1]), m[0], true);
  for (const m of text.matchAll(/amount due\s*:\s*\$([\d,]+(?:\.\d{2})?)/gi)) add("amount_due", money(m[1]), m[0]);
  for (const m of text.matchAll(/budget[^.$]*?\$([\d,]+(?:\.\d{2})?)/gi)) add("budget", money(m[1]), m[0]);
  for (const m of text.matchAll(/capped at (\d+(?:\.\d+)?)%/gi)) add("increase_cap_pct", Number(m[1]), m[0]);

  // A stated term ("Term: Nov 1, 2025 to Oct 31, 2026") bounds every fact in the text.
  const term = text.match(new RegExp(`Term:\\s*(${DATE})\\s*(?:to|-|–)\\s*(${DATE})`, "i"));
  if (term) {
    for (const f of facts) {
      f.validFrom = new Date(Date.parse(term[1] + " 00:00 UTC")).toISOString();
      f.validTo = new Date(Date.parse(term[2] + " 23:59 UTC")).toISOString();
    }
  }
  return facts;
}
