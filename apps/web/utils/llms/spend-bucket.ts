// Weekly AI spend is metered in two buckets so chat cannot exhaust the budget
// that per-email triage needs: once a user's chat spend crosses the weekly
// limit, triage must keep running on its configured model.
export type AiSpendBucket = "interactive" | "triage";

// The labels of the AI calls made for every incoming email. Call sites use
// these constants so a renamed label cannot silently move into the chat bucket.
export const TRIAGE_AI_LABELS = {
  chooseRule: "Choose rule",
  threadStatus: "Determine thread status",
  coldEmail: "Cold email check",
} as const;

// Triage cost scales with mail volume, not with how much a user chats, so its
// cap is a backstop against runaway reprocessing rather than a budget. A fixed
// multiple of the chat limit keeps it tied to the one configured spend limit.
export const TRIAGE_SPEND_LIMIT_MULTIPLIER = 3;

const triageLabels = new Set<string>(Object.values(TRIAGE_AI_LABELS));

export function getAiSpendBucket(label: string): AiSpendBucket {
  return triageLabels.has(label) ? "triage" : "interactive";
}
