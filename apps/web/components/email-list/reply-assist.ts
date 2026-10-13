import { createContext, type ReactNode } from "react";

/**
 * Cue's verified reply to one message, for that reply's composer: the text
 * it suggests, and what backs it.
 */
export type ReplyAssist = {
  messageId: string;
  /** Plain text, paragraphs separated by blank lines. */
  reply: string;
  evidence: ReactNode;
};

export const ReplyAssistContext = createContext<ReplyAssist | null>(null);

/**
 * Whether a composer's body is still exactly Cue's suggestion, so the reply
 * can keep saying where it came from. Markup, spacing and the signature
 * differ between the composer and the mailbox's copy; the words don't.
 */
export function isUneditedSuggestion(bodyHtml: string, reply: string) {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  for (const signature of doc.body.querySelectorAll(
    '[data-smartmail="gmail_signature"]',
  )) {
    signature.remove();
  }
  const words = withoutSpace(doc.body.textContent ?? "");
  return words.length > 0 && words === withoutSpace(reply);
}

function withoutSpace(text: string) {
  return text.replace(/[\s ]+/g, "");
}
