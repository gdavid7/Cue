// Step 5: from understanding to executable actions.
//
// Every action has a risk level:
//   low    — reversible and private (archive, add a calendar hold, set a reminder)
//   medium — visible to others but drafted for review (a follow-up nudge)
//   high   — irreversible and outward-facing (sending a reply)
//
// Autonomy is progressive (read-only → suggest → draft → one-click → automatic).
// Only *low*-risk actions can ever be automatic, and only through a rule the user
// can see and switch off.

import type { Action, Analysis, Intent } from "../core/types.ts";
import type { Signals } from "./brain.ts";

export interface AutonomyRule {
  id: string;
  label: string;
  enabled: boolean;
  matches: (a: Action, intent: Intent, s: Signals, analysis: Analysis) => boolean;
}

export function defaultRules(): AutonomyRule[] {
  return [
    {
      id: "file_noise",
      label: "File newsletters and receipts automatically",
      enabled: true,
      matches: (a, intent) => a.kind === "archive" && (intent === "newsletter" || intent === "receipt"),
    },
    {
      id: "school_dates",
      label: "Add dates from schools and activities to my calendar",
      enabled: true,
      // Only announcements: an automated sender that expects no reply (unlike "reply C to confirm").
      matches: (a, _i, s, analysis) => a.kind === "add_to_calendar" && s.counterpart.automated && analysis.replies.length === 0,
    },
    {
      id: "bill_reminders",
      label: "Set a reminder 2 days before bills are due",
      enabled: true,
      matches: (a, intent) => a.kind === "set_reminder" && intent === "bill",
    },
  ];
}

export function planActions(s: Signals, analysis: Analysis, intent: Intent, nextId: () => string): Action[] {
  const actions: Action[] = [];
  const add = (a: Omit<Action, "id" | "threadId" | "status">) => actions.push({ id: nextId(), threadId: s.threadId, status: "proposed", ...a });

  if (intent === "newsletter" || intent === "receipt") {
    add({ kind: "archive", label: intent === "newsletter" ? "File newsletter" : "File receipt", risk: "low", params: {} });
    return actions;
  }

  if (s.lastFromMe) {
    const nudge = analysis.replies[0];
    if (nudge && (s.waitingDays ?? 0) >= 3) {
      add({ kind: "nudge", label: `Nudge ${s.counterpart.name}`, risk: "medium", params: { body: nudge.body } });
    }
    return actions;
  }

  if (s.proposedTime && s.intents.includes("scheduling")) {
    add({
      kind: "add_to_calendar",
      label: `Add “${eventTitle(s)}” to calendar`,
      risk: "low",
      params: { title: eventTitle(s), start: s.proposedTime.start, end: s.proposedTime.end, allDay: s.proposedTime.allDay },
    });
  }

  if (intent === "bill" && s.deadline) {
    const at = new Date(Date.parse(s.deadline.date) - 2 * 86_400_000).toISOString();
    const due = s.facts.find((f) => f.key === "amount_due");
    add({
      kind: "set_reminder",
      label: "Remind me 2 days before it's due",
      risk: "low",
      params: { at, note: `Pay ${s.counterpart.name}${due ? ` $${due.value.toFixed(2)}` : ""}` },
    });
  } else if (intent === "decision" && s.deadline && s.deadline.daysLeft > 2) {
    const at = new Date(Date.parse(s.deadline.date) - 2 * 86_400_000).toISOString();
    add({ kind: "set_reminder", label: "Remind me before the deadline", risk: "low", params: { at, note: `Decide: ${s.subject}` } });
  }

  const attachments = s.bestDoc && s.intents.includes("document_request") ? [{ nodeId: s.bestDoc.nodeId, title: s.bestDoc.title }] : [];
  for (const reply of analysis.replies) {
    add({
      kind: "send_reply",
      label: analysis.replies.length > 1 ? `Reply: ${reply.label}` : attachments.length ? "Send reply + attachment" : "Send reply",
      risk: "high",
      params: { body: reply.body, attachments, option: reply.label },
    });
  }
  return actions;
}

const EVENT_NOUNS = /\b(picture day|game|practice|appointment|cleaning|check-?up|party|meeting|conference|recital|rehearsal|class)\b/i;

/** "Game · Dana Kim", "Picture Day · Lincoln Elementary" — short and scannable. */
function eventTitle(s: Signals): string {
  const noun = s.messages.at(-1)!.body.match(EVENT_NOUNS)?.[1];
  const what = noun ? noun.replace(/\b\w/g, (c) => c.toUpperCase()) : s.subject.replace(/^(re|fwd?):\s*/i, "");
  return `${what} · ${s.counterpart.name}`;
}
