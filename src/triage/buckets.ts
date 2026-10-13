// The home screen's four lanes, decided by product rules (not by the LLM):
//
//   Needs you       — decisions and replies that need the user's judgment
//   Cue is on it    — actions Cue is executing right now
//   Waiting         — the user asked someone something and is owed a reply
//   Taken care of   — routine mail filed, or handled by Cue / the user

import type { Action, Bucket, Intent } from "../core/types.ts";

export interface BucketInput {
  intent: Intent;
  lastFromMe: boolean;
  lastMineAsks: boolean;
  waitingDays?: number;
  archived: boolean;
  actions: Action[];
}

export function bucketOf(t: BucketInput): Bucket {
  if (t.actions.some((a) => a.status === "running")) return "cue_on_it";
  if (t.archived) return "taken_care_of";
  if (t.lastFromMe) return t.lastMineAsks && (t.waitingDays ?? 0) < 30 ? "waiting" : "taken_care_of";
  if (t.intent === "newsletter" || t.intent === "receipt") return "taken_care_of";

  const open = t.actions.filter((a) => a.status === "proposed");
  const autoHandled = t.actions.some((a) => a.status === "done" && a.autoRule);
  // A rule did the routine part, and nothing needing judgment is left.
  if (autoHandled && !open.some((a) => a.risk !== "low")) return "taken_care_of";
  if (t.intent === "fyi" && open.length === 0) return "taken_care_of";
  return "needs_you";
}

export interface PriorityInput {
  deadlineDays?: number;
  family: boolean;
  conflict: boolean;
  intent: Intent;
}

/** Higher = closer to the top of "Needs you". Returns the score and the main reason. */
export function priorityOf(p: PriorityInput): { score: number; reason?: string } {
  let score = 0;
  let reason: string | undefined;
  if (p.deadlineDays !== undefined) {
    score += p.deadlineDays <= 2 ? 3 : p.deadlineDays <= 7 ? 2 : 1;
    reason = p.deadlineDays <= 0 ? "Due today" : `Due in ${p.deadlineDays} day${p.deadlineDays === 1 ? "" : "s"}`;
  }
  if (p.conflict) {
    score += 1.5;
    reason ??= "Calendar conflict";
  }
  if (p.family) {
    score += 1.5;
    reason ??= "Family";
  }
  if (p.intent === "decision") score += 1;
  if (p.intent === "scheduling" || p.intent === "document_request") score += 0.5;
  return { score, reason };
}
