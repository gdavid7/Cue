import { z } from "zod";

const MAX_DRAFT_PART = 20_000;
const MAX_INSTRUCTION = 2000;

export const COMPOSE_ASSIST_ACTIONS = [
  "improve",
  "shorter",
  "formal",
  "friendly",
  "grammar",
  "translate",
  "custom",
] as const;

export const composeAssistBody = z
  .object({
    mode: z.enum(["rewrite", "write", "continue", "expand-notes"]),
    // For rewrite: what to do with the selection.
    action: z.enum(COMPOSE_ASSIST_ACTIONS).optional(),
    language: z.string().trim().min(1).max(60).optional(),
    // What the user typed: the request for write, or a custom rewrite.
    instruction: z.string().trim().max(MAX_INSTRUCTION).optional(),
    // Follow-ups typed after seeing a suggestion, oldest first.
    refinements: z
      .array(z.string().trim().min(1).max(MAX_INSTRUCTION))
      .max(5)
      .default([]),
    // The draft as text, split at the selection or the caret. For
    // expand-notes, text is the whole body.
    before: z.string().max(MAX_DRAFT_PART).default(""),
    text: z.string().max(MAX_DRAFT_PART).default(""),
    after: z.string().max(MAX_DRAFT_PART).default(""),
    threadId: z.string().trim().min(1).max(512).optional(),
    to: z.string().max(2000).optional(),
    subject: z.string().max(1000).optional(),
  })
  .superRefine((body, ctx) => {
    const require = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (body.mode === "rewrite" && !body.text.trim())
      require("text", "Select text to rewrite.");
    if (body.mode === "rewrite" && !body.action)
      require("action", "Choose what to do with the selection.");
    if (body.action === "translate" && !body.language)
      require("language", "Choose a language.");
    if (
      (body.mode === "write" || body.action === "custom") &&
      !body.instruction
    )
      require("instruction", "Say what to write.");
    if (body.mode === "expand-notes" && !body.text.trim())
      require("text", "There are no notes to turn into an email.");
  });

export type ComposeAssistBody = z.input<typeof composeAssistBody>;
