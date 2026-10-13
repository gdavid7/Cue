// Step 2: entity resolution — deciding that "Dana Kim <dana.kim@eastsideyouthsoccer.org>"
// in Gmail and "Coach Dana <dana.hornets@gmail.com>" on a calendar invite are the
// same human.
//
// Rule from the brief: prefer deterministic joins (exact email) and only fall back
// to fuzzy matching for ambiguous cases — and when we do, record a confidence
// below 1 so downstream code knows the link might be wrong.

import type { Identity } from "../core/types.ts";
import { tokenize } from "../retrieve/text.ts";

export interface Person {
  id: string;
  name: string;
  emails: Set<string>;
  names: Set<string>;
  /** Words seen near this person (subjects, bodies). Used as evidence for fuzzy matches. */
  contextTokens: Set<string>;
  automated: boolean;
}

export interface Resolution {
  personId: string;
  confidence: number;
  method: "self" | "email" | "name+context" | "new";
}

const HONORIFICS = new Set(["coach", "dr", "mr", "mrs", "ms", "miss", "prof", "teacher", "aunt", "uncle"]);
const CONSUMER_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "me.com"]);
const AUTOMATED_LOCALPARTS = /^(no-?reply|billing|news|newsletter|receipts?|shipment-tracking|notifications?|office|appointments|info|support)$/;

export const MERGE_THRESHOLD = 0.7;
export const SELF_ID = "person_me";

export class EntityResolver {
  people = new Map<string, Person>();
  private byEmail = new Map<string, string>();
  private seq = 0;
  private selfEmails: Set<string>;

  constructor(selfName: string, selfEmails: string[]) {
    this.selfEmails = new Set(selfEmails.map((e) => e.toLowerCase()));
    this.people.set(SELF_ID, {
      id: SELF_ID, name: selfName, emails: new Set(this.selfEmails), names: new Set([selfName]),
      contextTokens: new Set(), automated: false,
    });
    for (const e of this.selfEmails) this.byEmail.set(e, SELF_ID);
  }

  /**
   * Resolve one identity. `context` is nearby text (an event title, an email subject)
   * used as supporting evidence when only a fuzzy name match is available.
   */
  resolve(identity: Identity, context = ""): Resolution {
    const email = identity.email?.toLowerCase();

    // 1. Deterministic: we've seen this exact address before.
    if (email && this.byEmail.has(email)) {
      const personId = this.byEmail.get(email)!;
      this.learn(personId, identity, context);
      return { personId, confidence: 1, method: personId === SELF_ID ? "self" : "email" };
    }

    // 2. Fuzzy: compare names, then look for corroborating context.
    const best = this.bestFuzzyMatch(identity, context);
    if (best && best.score >= MERGE_THRESHOLD) {
      if (email) this.byEmail.set(email, best.person.id);
      this.learn(best.person.id, identity, context);
      return { personId: best.person.id, confidence: round(best.score), method: "name+context" };
    }

    // 3. Someone new.
    const id = `person_${++this.seq}`;
    const local = email?.split("@")[0] ?? "";
    this.people.set(id, {
      id,
      name: identity.name ?? email ?? "Unknown",
      emails: new Set(email ? [email] : []),
      names: new Set(identity.name ? [identity.name] : []),
      contextTokens: new Set(),
      automated: AUTOMATED_LOCALPARTS.test(local),
    });
    if (email) this.byEmail.set(email, id);
    this.learn(id, identity, context);
    return { personId: id, confidence: 1, method: "new" };
  }

  private bestFuzzyMatch(identity: Identity, context: string) {
    if (!identity.name) return null;
    const theirs = nameTokens(identity.name);
    if (theirs.size === 0) return null;
    const ctx = new Set(tokenize(context));

    let best: { person: Person; score: number } | null = null;
    for (const person of this.people.values()) {
      if (person.id === SELF_ID || person.automated) continue;
      let nameScore = 0;
      for (const n of person.names) {
        const ours = nameTokens(n);
        const shared = [...theirs].filter((t) => ours.has(t)).length;
        if (shared === 0) continue;
        // Identical full names are strong evidence; a shared first name alone is weak.
        const s = shared === ours.size && shared === theirs.size ? 0.85 : 0.6 * (shared / Math.min(ours.size, theirs.size));
        nameScore = Math.max(nameScore, s);
      }
      if (nameScore === 0) continue;
      // Corroboration: how much of the surrounding context has this person been seen with?
      const overlap = ctx.size ? [...ctx].filter((t) => person.contextTokens.has(t)).length / ctx.size : 0;
      const score = Math.min(0.99, nameScore + 0.25 * overlap);
      if (!best || score > best.score) best = { person, score };
    }
    return best;
  }

  private learn(personId: string, identity: Identity, context: string) {
    const p = this.people.get(personId)!;
    if (identity.name) p.names.add(identity.name);
    for (const t of tokenize(context)) p.contextTokens.add(t);
  }
}

/** Organization implied by an email domain, unless it's a consumer mail provider. */
export function orgFromEmail(email?: string): string | null {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (!domain || CONSUMER_DOMAINS.has(domain)) return null;
  return domain;
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t && !HONORIFICS.has(t)),
  );
}

const round = (x: number) => Math.round(x * 100) / 100;
