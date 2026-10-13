// Offline brain: template-based summaries and drafts built from Signals.
// No network, fully deterministic — Cue works (less eloquently) without an LLM.

import type { Analysis, ReplyOption } from "../core/types.ts";
import { formatLocal } from "../core/time.ts";
import type { Brain, Signals } from "./brain.ts";

const REQUEST = /\?|please|could you|can you|confirm|due date|amount due|reminder|rescheduled|offering|following up|still (?:don't|do not|need)/i;

export class HeuristicBrain implements Brain {
  readonly name = "heuristic" as const;

  async analyze(s: Signals): Promise<Analysis> {
    return this.analyzeNow(s);
  }

  analyzeNow(s: Signals): Analysis {
    return { summary: summarize(s), whatMatters: whatMatters(s), replies: drafts(s), by: "heuristic" };
  }
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
}

/** The body without greeting ("Hi Dana,") and sign-off ("Thanks,\nAlex") lines. */
function content(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const signoff = lines.findIndex((l) => /^(thanks|thank you|love|best|cheers|regards|sincerely)[,!]?$/i.test(l));
  return (signoff >= 0 ? lines.slice(0, signoff) : lines).filter((l) => !/^(hi|hello|hey|dear)\b[^.?!]*,$/i.test(l)).join(" ");
}

function summarize(s: Signals): string {
  const last = s.messages.at(-1)!;
  const said = sentences(content(last.body));
  if (s.lastFromMe) {
    const ask = said.find((x) => x.includes("?"));
    return ask ? `You asked ${s.counterpart.name}: “${clip(ask, 140)}”` : `You replied: “${clip(said[0] ?? last.subject, 140)}”`;
  }
  const key = said.filter((x) => REQUEST.test(x));
  return clip((key.length ? key.slice(0, 4) : said.slice(0, 1)).join(" "), 280);
}

function whatMatters(s: Signals): string[] {
  const out: string[] = [];
  const t = (iso: string) => formatLocal(iso, s.tz).split(", ").at(-1)!; // just the time

  if (s.deadline) {
    const when = s.deadline.daysLeft <= 0 ? "today" : s.deadline.daysLeft === 1 ? "tomorrow" : `in ${s.deadline.daysLeft} days`;
    out.push(`${s.deadline.label} ${formatLocal(s.deadline.date, s.tz, false)} (${when}).`);
  }

  if (s.proposedTime) {
    const clash = s.sameDayEvents.filter((e) => e.overlaps);
    const after = s.sameDayEvents.filter((e) => !e.overlaps && e.start >= s.proposedTime!.end && Date.parse(e.start) - Date.parse(s.proposedTime!.end) <= 2 * 3_600_000);
    if (clash.length) out.push(`Conflict: ${clash.map((e) => `${e.title} (${t(e.start)})`).join(", ")} overlaps ${s.proposedTime.label}.`);
    else if (s.sameDayEvents.length === 0) out.push(`Your calendar is clear for ${s.proposedTime.label}.`);
    else out.push(`You're free for ${s.proposedTime.label}.`);
    for (const e of after) out.push(`Heads up: ${e.title} starts at ${t(e.start)}, right after.`);
  }

  if (s.bestDoc) out.push(`Found “${s.bestDoc.title}” in your Google Drive.`);

  // Offers vs. what's currently true, e.g. a rent increase vs. the lease on file.
  for (const offer of s.facts.filter((f) => f.proposed)) {
    const current = s.facts.find((f) => f.key === offer.key && !f.proposed);
    if (!current) continue;
    const diff = offer.value - current.value;
    const pct = (diff / current.value) * 100;
    let line = `${money(offer.value)} is ${diff >= 0 ? "+" : "−"}${money(Math.abs(diff))} (${pct.toFixed(1)}%) vs. your current ${money(current.value)}`;
    const cap = s.facts.find((f) => f.key === "increase_cap_pct" && !f.proposed);
    if (cap) line += pct <= cap.value ? `, within the ${cap.value}% cap in your lease` : `, above the ${cap.value}% cap in your lease`;
    out.push(line + ".");
  }
  const due = s.facts.find((f) => f.key === "amount_due");
  if (due) out.push(`Amount due: ${money(due.value)}.`);

  for (const x of s.crossInbox.slice(0, 1)) out.push(`From your ${x.accountLabel}: ${x.sentence}`);

  if (s.waitingDays !== undefined) out.push(`No reply from ${s.counterpart.name} in ${Math.floor(s.waitingDays)} days.`);
  return out;
}

function drafts(s: Signals): ReplyOption[] {
  if (s.counterpart.automated && !/reply \w to confirm/i.test(s.messages.at(-1)!.body)) return [];
  const last = s.messages.at(-1)!;
  const hi = `Hi ${s.counterpart.greetingName},`;
  const bye = `${s.counterpart.family ? "Love" : "Thanks"},\n${s.user.firstName}`;
  const wrap = (...lines: string[]) => [hi, "", ...lines.filter(Boolean), "", bye].join("\n");
  const attach = s.bestDoc && s.intents.includes("document_request") ? `I've attached ${stripExt(s.bestDoc.title)}.` : "";

  if (s.lastFromMe) {
    const when = formatLocal(last.sentAt, s.tz, false);
    return [{ label: "Follow up", body: wrap(`Just following up on my note from ${when} about “${last.subject}”. Any update?`) }];
  }

  const confirmLetter = last.body.match(/reply (\w) to confirm/i)?.[1];
  if (confirmLetter) {
    return [{ label: "Confirm", body: `${confirmLetter}\n\nConfirmed${s.proposedTime ? ` for ${s.proposedTime.label}` : ""}. Thank you!\n${s.user.firstName}` }];
  }

  if (s.intents.includes("scheduling") && s.proposedTime) {
    const who = last.body.match(/can (\w+) make it/i)?.[1];
    const clash = s.sameDayEvents.some((e) => e.overlaps);
    const yes = who ? `Yes, ${who} can make it ${s.proposedTime.label}.` : `${s.proposedTime.label} works for me.`;
    const no = who ? `Unfortunately ${who} can't make it ${s.proposedTime.label}, we have a conflict.` : `${s.proposedTime.label} doesn't work for me. Could we find another time?`;
    const options = [{ label: "Yes", body: wrap(yes, attach) }, { label: "Can't make it", body: wrap(no, attach) }];
    return clash ? options.reverse() : options;
  }

  if (s.intents.includes("decision")) {
    const offer = s.facts.find((f) => f.proposed);
    const terms = offer ? ` at ${money(offer.value)}${offer.key === "rent" ? "/month" : ""}` : "";
    return [
      { label: "Accept", body: wrap(`Thanks for the offer. Yes, I'd like to go ahead${terms}. Please send over what you need from me.`) },
      { label: "Decline", body: wrap("Thanks for the offer. I've decided not to go ahead this time.") },
    ];
  }

  if (s.intents.includes("document_request") && attach) return [{ label: "Send it", body: wrap(attach) }];

  if (s.intents.includes("question")) {
    const found = s.crossInbox[0]?.sentence ?? s.context[0]?.snippet;
    return [{ label: "Reply", body: wrap(found ? `Here's what I have: ${found}` : "[your answer]") }];
  }
  return [];
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n - 1) + "…" : x);
const stripExt = (x: string) => x.replace(/\.(pdf|docx?|png|jpe?g)$/i, "");
