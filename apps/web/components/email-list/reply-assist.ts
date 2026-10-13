import { createContext, type ReactNode } from "react";

/**
 * Cue's help for the reply to one message, shown in that reply's composer:
 * the text it suggests, and a line under it saying what backs it, or why Cue
 * left the reply to the user.
 */
export type ReplyAssist = {
  messageId: string;
  suggestedBodyHtml?: string;
  footer?: ReactNode;
};

export const ReplyAssistContext = createContext<ReplyAssist | null>(null);
