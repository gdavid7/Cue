import LinkifyIt from "linkify-it";
import tlds from "tlds";
import type { MailPlainTextSegment } from "./MailBody";
import { getSafeEmailLinkUrl } from "./safe-link-url";

const linkify = new LinkifyIt().tlds(tlds).add("ftp:", null);

// Senders wrap long URLs at ~76 columns and enclose them in <...> so readers
// can rejoin them (RFC 3986 appendix C). The class stops at the next bracket,
// so each scan ends where the next candidate begins and the search stays linear.
const BRACKETED_URL = /<((?:https?|mailto):[^<>]{1,8192})>/gi;
const WHITESPACE = /\s+/g;
// Whitespace that has no line break is a real space, not a wrap.
const SPACE_BETWEEN_WORDS = /\S[^\S\n]+\S/;

// Linkifying costs ~0.25ms per KB of text. Gmail clips a message at ~100KB,
// so links past this budget stay plain text instead of slowing a huge body.
const LINKIFY_TEXT_BUDGET = 100_000;

// Text inside these is not prose a reader would expect to click.
const UNLINKED_ELEMENTS = new Set([
  "A",
  "BUTTON",
  "HEAD",
  "NOSCRIPT",
  "OPTION",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "TEMPLATE",
  "TEXTAREA",
  "TITLE",
]);

export function linkifyPlainText(
  text: string,
  budget = LINKIFY_TEXT_BUDGET,
): MailPlainTextSegment[] {
  const linkable = text.length > budget ? cutAtWhitespace(text, budget) : text;
  const segments: MailPlainTextSegment[] = [];
  let lastIndex = 0;

  for (const match of linkable.matchAll(BRACKETED_URL)) {
    const inner = match[1];
    if (!inner?.includes("\n") || SPACE_BETWEEN_WORDS.test(inner)) continue;
    const href = getSafeEmailLinkUrl(inner.replace(WHITESPACE, ""));
    if (!href) continue;

    const start = match.index + 1;
    pushLinkifiedText(segments, linkable.slice(lastIndex, start));
    segments.push({ type: "link", text: inner, href });
    lastIndex = start + inner.length;
  }

  pushLinkifiedText(segments, linkable.slice(lastIndex));
  if (linkable.length < text.length) {
    segments.push({ type: "text", text: text.slice(linkable.length) });
  }
  return segments.length ? segments : [{ type: "text", text }];
}

/**
 * Wraps bare URLs and addresses in an already sanitized document in links, as
 * Gmail does. Anchors are built with DOM APIs, so URL text never becomes markup.
 */
export function linkifyMailHtml(root: Element) {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return UNLINKED_ELEMENTS.has((node as Element).tagName)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );

  // Each text node is linkified with the budget left after the ones before it.
  const pending: [textNode: Text, budget: number][] = [];
  let budget = LINKIFY_TEXT_BUDGET;
  for (
    let node = walker.nextNode();
    node && budget > 0;
    node = walker.nextNode()
  ) {
    const textNode = node as Text;
    if (!linkify.pretest(textNode.data)) continue;
    pending.push([textNode, budget]);
    budget -= textNode.data.length;
  }

  for (const [textNode, remainingBudget] of pending) {
    const segments = linkifyPlainText(textNode.data, remainingBudget);
    if (!segments.some((segment) => segment.type === "link")) continue;

    const fragment = document.createDocumentFragment();
    for (const segment of segments) {
      if (segment.type === "text") {
        fragment.append(segment.text);
        continue;
      }
      const anchor = document.createElement("a");
      anchor.setAttribute("href", segment.href);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.textContent = segment.text;
      fragment.append(anchor);
    }
    textNode.replaceWith(fragment);
  }
}

function pushLinkifiedText(segments: MailPlainTextSegment[], text: string) {
  if (!text) return;
  const matches = linkify.match(text);
  let lastIndex = 0;

  for (const match of matches ?? []) {
    const href = getSafeEmailLinkUrl(match.url);
    if (!href) continue;

    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "link", text: match.raw, href });
    lastIndex = match.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }
}

function cutAtWhitespace(text: string, limit: number) {
  const breakAt = Math.max(
    text.lastIndexOf(" ", limit),
    text.lastIndexOf("\n", limit),
  );
  return text.slice(0, Math.max(breakAt, 0));
}
