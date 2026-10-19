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
  /**
   * Set for a rule's suggestion, which waits in Cue until the user edits it.
   * The draft its first edit becomes is remembered against it.
   */
  executedActionId?: string;
  /** Turns the rule's suggestion down, as discarding its reply does. */
  dismiss?: () => void;
  /** Recipients and subject the rule chose, when not the usual reply's. */
  recipients?: { to?: string; cc?: string; bcc?: string; subject?: string };
  /** Names of the files the rule attaches. */
  files?: string[];
  /**
   * The rule's reply goes to someone other than the sender, so the user's own
   * Reply doesn't open with it.
   */
  toSomeoneElse?: boolean;
  /** How the composer credits it, when "Suggested by Cue" would mislead. */
  label?: string;
};

export const ReplyAssistContext = createContext<ReplyAssist | null>(null);

/**
 * Whether a composer's body is still exactly Cue's suggestion, so the reply
 * can keep saying where it came from. Markup, spacing and the signature
 * differ between the composer and the mailbox's copy; the words don't.
 */
export function isUneditedSuggestion(bodyHtml: string, reply: string) {
  const words = withoutSpace(bodyText(bodyHtml));
  return words.length > 0 && words === withoutSpace(reply);
}

/**
 * Whether a reply holds nothing the user wrote: no words, or exactly Cue's
 * suggestion with the recipients it came with, and no files.
 */
export function isUnwrittenReply(content: {
  draft: { editableHtml: string };
  values: { to?: string; cc?: string; bcc?: string; subject?: string };
  attachments: unknown[];
  startedFrom?: {
    reply: string;
    values?: { to?: string; cc?: string; bcc?: string; subject?: string };
  };
}) {
  if (content.attachments.length) return false;
  const html = content.draft.editableHtml;
  if (!withoutSpace(bodyText(html))) return true;
  const origin = content.startedFrom;
  return Boolean(
    origin &&
      isUneditedSuggestion(html, origin.reply) &&
      (["to", "cc", "bcc", "subject"] as const).every(
        (field) =>
          (content.values[field] ?? "") === (origin.values?.[field] ?? ""),
      ),
  );
}

function bodyText(bodyHtml: string) {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  for (const signature of doc.body.querySelectorAll(
    '[data-smartmail="gmail_signature"]',
  )) {
    signature.remove();
  }
  return doc.body.textContent ?? "";
}

function withoutSpace(text: string) {
  return text.replace(/[\s ]+/g, "");
}
