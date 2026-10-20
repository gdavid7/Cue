import { z } from "zod";

// What the user did with one of Cue's suggestions in the composer. Texts are
// plain, as the suggestion panel showed them.
export const composeAssistOutcome = z.object({
  outcome: z.enum(["accepted", "discarded"]),
  // What the user asked Cue for, as the panel named it.
  request: z.string().trim().min(1).max(2000),
  // Follow-ups typed after seeing a suggestion, oldest first.
  refinements: z.array(z.string().trim().min(1).max(2000)).max(5),
  // The selection a rewrite replaced; empty when Cue wrote new text.
  original: z.string().max(10_000),
  suggestion: z.string().trim().min(1).max(10_000),
});
export type ComposeAssistOutcome = z.infer<typeof composeAssistOutcome>;

export const recordComposeAssistOutcomeBody = z.object({
  threadId: z.string().trim().min(1).max(512),
  /** The message the reply answers. */
  messageId: z.string().trim().min(1).max(512),
  outcome: composeAssistOutcome,
});

/** Outcomes stored on a ComposeAssistReply; a malformed list reads as none. */
export function parseComposeAssistOutcomes(value: unknown) {
  const parsed = z.array(composeAssistOutcome).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** The part of a reply Cue wrote, as the user accepted it. */
export function getAcceptedSuggestionsText(outcomes: ComposeAssistOutcome[]) {
  return outcomes
    .filter((outcome) => outcome.outcome === "accepted")
    .map((outcome) => outcome.suggestion)
    .join("\n\n");
}
