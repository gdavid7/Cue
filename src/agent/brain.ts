// The "brain" turns deterministic signals about a thread into words: a summary,
// the few things that matter, and reply drafts.
//
// Division of labor (important for safety):
//   - Code decides *facts* (conflicts, deadlines, which file) and *actions*
//     (what can run, how risky, who must approve).
//   - The brain only writes language. It can't execute anything; drafts are sent
//     only after the user approves them.

import type { Analysis, ContextItem, Intent, Message } from "../core/types.ts";

export interface FactSignal {
  key: string;
  value: number;
  text: string;
  proposed: boolean;
  /** Source label, e.g. a doc title. */
  from: string;
}

export interface DayEvent {
  title: string;
  start: string;
  end: string;
  overlaps: boolean;
}

/** Everything code has already worked out about a thread, handed to the brain. */
export interface Signals {
  threadId: string;
  subject: string;
  messages: Message[];
  lastFromMe: boolean;
  /** Who we'd be replying to. */
  counterpart: { name: string; greetingName: string; family: boolean; automated: boolean };
  intents: Intent[];
  deadline?: { date: string; label: string; daysLeft: number };
  proposedTime?: { start: string; end: string; label: string; allDay: boolean };
  sameDayEvents: DayEvent[];
  bestDoc?: ContextItem;
  context: ContextItem[];
  facts: FactSignal[];
  /** Cross-inbox finds: context items from a different account than the thread. */
  crossInbox: { item: ContextItem; accountLabel: string; sentence: string }[];
  waitingDays?: number;
  user: { name: string; firstName: string };
  now: string;
  tz: string;
}

export interface Brain {
  readonly name: "heuristic" | "claude";
  analyze(s: Signals): Promise<Analysis>;
}
