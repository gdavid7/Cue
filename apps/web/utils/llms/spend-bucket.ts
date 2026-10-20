// Weekly AI spend is metered in two buckets so chat cannot exhaust the budget
// that automated per-email work needs: once a user's chat spend crosses the
// weekly limit, background processing must keep running on its configured
// model.
export type AiSpendBucket = "interactive" | "triage";

// The "triage" bucket covers the AI calls made automatically for each
// incoming email: classifying it (rule choice, thread status, cold email,
// sender category), acting on it (rule action args, the drafted reply and the
// context and reply memories it is drafted from) and summarizing it for the
// digest. Call sites use these constants so a renamed label cannot silently
// move into the interactive bucket.
//
// "Reply memory selection" and "Categorize sender" also run when a user asks
// for them in the UI (compose assist, suggested replies, manual categorize).
// The bucket is chosen by label, and the automated per-email runs make up
// most of those calls, so they count as triage.
export const TRIAGE_AI_LABELS = {
  chooseRule: "Choose rule",
  threadStatus: "Determine thread status",
  coldEmail: "Cold email check",
  categorizeSender: "Categorize sender",
  ruleArgs: "Args for rule",
  draftReply: "Draft reply",
  predraftReply: "Pre-drafted reply suggestion",
  replyContextCollector: "Reply context collector",
  replyMemorySelection: "Reply memory selection",
  digestSummary: "Summarize email",
} as const;

// Triage cost scales with mail volume, not with how much a user chats, so its
// cap is a backstop against runaway reprocessing rather than a budget. A fixed
// multiple of the chat limit keeps it tied to the one configured spend limit.
export const TRIAGE_SPEND_LIMIT_MULTIPLIER = 3;

const triageLabels = new Set<string>(Object.values(TRIAGE_AI_LABELS));

export function getAiSpendBucket(label: string): AiSpendBucket {
  return triageLabels.has(label) ? "triage" : "interactive";
}
