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
 * as anchors. The composer escapes the text again itself, so this reads the
 * text the HTML shows, decoded exactly once, and never keeps markup. The
 * document is inert: nothing in it runs or loads.
 */
export function draftHtmlToReplyText(html: string) {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  let text = "";
  const breakLine = () => {
    text = text.replace(/[ \t]+$/, "");
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const walk = (node: Node, inPre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = node.textContent ?? "";
      // The stored body keeps the reply's line breaks as newlines.
      if (inPre) {
        text += data;
        return;
      }
      const collapsed = data
        .replace(/[ \t\f\r]+/g, " ")
        .replace(/ ?\n ?/g, "\n");
      text += !text || text.endsWith("\n") ? collapsed.trimStart() : collapsed;
      return;
    }
    if (!(node instanceof Element)) return;
    const element = node.localName;
    if (UNSHOWN_ELEMENTS.has(element)) return;
    if (element === "br") {
      text += "\n";
      return;
    }
    if (element === "a") {
      text += linkText({
        href: node.getAttribute("href")?.trim() ?? "",
        label: (node.textContent ?? "").replace(/\s+/g, " "),
      });
      return;
    }
    const block = BLOCK_ELEMENTS.has(element);
    if (block) breakLine();
    for (const child of node.childNodes)
      walk(child, inPre || element === "pre");
    if (block) breakLine();
    else if (CELL_ELEMENTS.has(element) && !/\s$/.test(text)) text += " ";
  };
  walk(doc.body, false);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A local draft opened from a rule's reply before DR-6 shows and sends the
 * stored HTML as text: "&#x27;" for "'", and any markup as tags. Such a
 * draft has no `decoded` mark. One still untouched opens again from the
 * decoded reply; an edited one gets its opening rebuilt when it is still
 * there, or else only the second escape undone. Then it is marked, so it is
 * repaired once, and a draft opened since is never touched: one saved after
 * DR-6 shipped carries the mark, or is plain text saved without it.
 */
export function withSuggestionEscapesRepaired<
  T extends {
    /** When the draft was last saved, in ms; 0 when unknown. */
    updatedAt: number;
    content: {
      draft: { editableHtml: string };
      startedFrom?: {
        reply: string;
        executedActionId?: string;
        decoded?: true;
      };
    } | null;
  },
>(stored: T): T {
  const content = stored.content;
  const html = content?.draft.editableHtml;
  const origin = content?.startedFrom;
  if (typeof DOMParser === "undefined") return stored;
  if (!content || !html || !origin?.executedActionId || origin.decoded)
    return stored;
  // Drafts saved since DR-6 shipped hold plain text without the mark. Only
  // a tab still running the old code saves stored HTML, and only for a while.
  if (stored.updatedAt >= DR6_IN_PRODUCTION + LEGACY_TAB_GRACE_MS)
    return stored;
  if (stored.updatedAt >= DR6_IN_PRODUCTION && !looksStoredHtml(origin.reply))
    return stored;
  const reply = draftHtmlToReplyText(origin.reply);
  const opening = textToHtmlParagraphs(reply);
  const oldOpening = textToHtmlParagraphs(origin.reply);
  let editableHtml: string;
  if (isUneditedSuggestion(html, origin.reply)) editableHtml = opening;
  else if (html.startsWith(oldOpening))
    editableHtml = opening + html.slice(oldOpening.length);
  else editableHtml = html.replace(DOUBLE_ESCAPED_ALL, "&$1;");
  return {
    ...stored,
    content: {
      ...content,
      draft: { ...content.draft, editableHtml },
      startedFrom: { ...origin, reply, decoded: true },
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

// Stored HTML escapes the reply's text, so outside its tags it has entities
// but no quote marks or bare "&"; a plain-text reply has those as written.
function looksStoredHtml(reply: string) {
  if (!STORED_HTML.test(reply)) return false;
  const text = reply.replace(/<\/?[a-z][^>]*>/gi, "");
  return !/["']|&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/i.test(text);
}

function withoutSpace(text: string) {
  return text.replace(/[\s ]+/g, "");
}

// When the reader started decoding a rule's reply (DR-6) in production.
const DR6_IN_PRODUCTION = Date.parse("2026-10-20T18:05:38Z");
const LEGACY_TAB_GRACE_MS = 48 * 60 * 60 * 1000;

// What `he.escape` writes, and the same escaped a second time.
const STORED_HTML = /&(#x27|#x60|quot|amp|lt|gt);/;
const DOUBLE_ESCAPED_ALL = /&amp;(#x27|#x60|quot|amp|lt|gt);/g;

const UNSHOWN_ELEMENTS = new Set([
  "head",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);
const CELL_ELEMENTS = new Set(["td", "th"]);

const BLOCK_ELEMENTS = new Set([
  "blockquote",
  "div",
  "hr",
  "ol",
  "pre",
  "table",
  "ul",
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
