import he from "he";
import { createContext, type ReactNode } from "react";
import { textToHtmlParagraphs } from "@/utils/string";

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
 * A rule's reply as the plain text `ReplyAssist.reply` holds. The rule stores
 * the HTML body the mailbox would get: its text escaped, newlines kept, links
 * as anchors. The composer escapes the text again itself, so this decodes it
 * exactly once and never keeps markup.
 */
export function draftHtmlToReplyText(html: string) {
  let text = "";
  let link: { href: string; label: string } | undefined;
  let skipUntil: string | undefined;
  const append = (part: string) => {
    if (link) link.label += part;
    else text += part;
  };
  for (const [index, part] of html.split(HTML_TOKEN).entries()) {
    if (index % 2 === 0) {
      if (!skipUntil) append(he.decode(part));
      continue;
    }
    const tag = /^<(\/?)([a-z][a-z0-9]*)/i.exec(part);
    if (!tag) continue;
    const [, closing, name] = tag;
    const element = name.toLowerCase();
    if (skipUntil) {
      if (closing && element === skipUntil) skipUntil = undefined;
      continue;
    }
    if (UNSHOWN_ELEMENTS.has(element) && !closing) skipUntil = element;
    else if (element === "br") append("\n");
    else if (element === "a" && !closing) {
      const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(part);
      link = {
        href: he.decode(href?.[1] ?? href?.[2] ?? "", {
          isAttributeValue: true,
        }),
        label: "",
      };
    } else if (element === "a" && link) {
      text += linkText(link);
      link = undefined;
    } else if (CELL_ELEMENTS.has(element) && closing && !/\s$/.test(text)) {
      text += " ";
    } else if (BLOCK_ELEMENTS.has(element) && text && !text.endsWith("\n")) {
      text = `${text.replace(/[ \t]+$/, "")}\n`;
    }
  }
  if (link) text += linkText(link);
  return text.trim();
}

/**
 * A local draft opened from a rule's reply before the reply was decoded
 * (DR-6) shows and sends the stored HTML as text: "&#x27;" for "'", and any
 * markup as tags. One still untouched opens again from the decoded reply;
 * an edited one keeps the user's words with the second escape undone. Only
 * a reply still stored as HTML qualifies, so a repaired draft, or one opened
 * since, is never decoded again.
 */
export function withSuggestionEscapesRepaired<
  T extends {
    content: {
      draft: { editableHtml: string };
      startedFrom?: { reply: string; executedActionId?: string };
    } | null;
  },
>(stored: T): T {
  const content = stored.content;
  const html = content?.draft.editableHtml;
  const origin = content?.startedFrom;
  if (!content || !html || !origin?.executedActionId) return stored;
  if (!STORED_HTML.test(origin.reply)) return stored;
  const reply = draftHtmlToReplyText(origin.reply);
  let editableHtml: string;
  if (isUneditedSuggestion(html, origin.reply))
    editableHtml = textToHtmlParagraphs(reply);
  else if (DOUBLE_ESCAPED.test(html))
    editableHtml = html.replace(DOUBLE_ESCAPED_ALL, "&$1;");
  else return stored;
  return {
    ...stored,
    content: {
      ...content,
      draft: { ...content.draft, editableHtml },
      startedFrom: { ...origin, reply },
    },
  };
}

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

// What `he.escape` writes, and the same escaped a second time.
const STORED_HTML = /&(#x27|#x60|quot|amp|lt|gt);/;
const DOUBLE_ESCAPED = /&amp;(#x27|#x60|quot|amp|lt|gt);/;
const DOUBLE_ESCAPED_ALL = new RegExp(DOUBLE_ESCAPED.source, "g");

// A comment, or a tag whose quoted attributes may hold ">".
const HTML_TOKEN = /(<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>)/i;
const UNSHOWN_ELEMENTS = new Set([
  "head",
  "script",
  "style",
  "template",
  "title",
]);
const CELL_ELEMENTS = new Set(["td", "th"]);

const BLOCK_ELEMENTS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "tr",
]);

// Plain text can't hide a destination behind words, so it shows both.
function linkText({ href, label }: { href: string; label: string }) {
  const words = label.trim();
  if (!href || href.startsWith("mailto:") || words === href) return label;
  return words ? `${label} (${href})` : href;
}
