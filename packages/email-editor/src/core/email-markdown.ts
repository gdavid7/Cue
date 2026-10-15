import { Marked } from "marked";
import { toEmailStyledHtml } from "./email-styles";

// Markdown's block structure, the part that plain text never has by accident.
// Inline emphasis alone is not enough: "*" and "_" show up in ordinary text.
const FENCED_CODE = /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/mu;
const HEADING = /^#{1,6}[ \t]+\S/mu;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\S/gmu;
const TABLE =
  /^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/mu;
const LINK = /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/u;

const markdown = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    // Raw HTML in pasted text is text the person wants to show, not markup.
    html: ({ text }) => escapeHtml(text),
    // Checkboxes are form controls, which mail clients drop.
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
  },
});

/** Whether plain text is clearly markdown rather than prose. */
export function looksLikeMarkdown(text: string) {
  return (
    FENCED_CODE.test(text) ||
    HEADING.test(text) ||
    TABLE.test(text) ||
    LINK.test(text) ||
    (text.match(LIST_ITEM)?.length ?? 0) >= 2
  );
}

/**
 * Renders markdown as email HTML with the inline styles mail clients need.
 * The result is not sanitized; it goes through the body profile like any
 * other HTML entering a message.
 */
export function markdownToEmailHtml(text: string) {
  return toEmailStyledHtml(markdown.parse(text) as string);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
