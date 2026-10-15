import { Marked, type Token, type Tokens } from "marked";
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

// For text nobody typed, such as a model's: an image would load from wherever
// it points as soon as it is shown, and track whoever opens the email. It is
// written out as text instead, so nothing loads and nothing is hidden.
const markdownWithoutImages = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
    image: ({ href, text }) => escapeHtml(describeLink(text, href)),
  },
});

/**
 * Renders markdown as email HTML with the inline styles mail clients need.
 * The result is not sanitized; it goes through the body profile like any
 * other HTML entering a message. With `images: false`, images become text
 * naming their address.
 */
export function markdownToEmailHtml(
  text: string,
  { images = true }: { images?: boolean } = {},
) {
  const parser = images ? markdown : markdownWithoutImages;
  return toEmailStyledHtml(parser.parse(text) as string);
}

/**
 * The words markdown renders to, as `markdownToEmailHtml(text, { images:
 * false })` shows them, with every link's address in view, so someone can
 * check what they are about to put in an email.
 */
export function markdownToPlainText(text: string) {
  return blocksToText(markdown.lexer(text))
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function blocksToText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "space":
          return "";
        case "list":
          return (token as Tokens.List).items
            .map((item, index) => {
              const marker = (token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + index}. `
                : "- ";
              return `${marker}${blocksToText(item.tokens).trim()}`;
            })
            .join("\n");
        case "code":
          return (token as Tokens.Code).text;
        case "hr":
          return "---";
        case "html":
          return (token as Tokens.HTML).text.trim();
        case "table": {
          const table = token as Tokens.Table;
          return [table.header, ...table.rows]
            .map((row) =>
              row.map((cell) => inlineToText(cell.tokens)).join(" | "),
            )
            .join("\n");
        }
        default: {
          const nested = (token as { tokens?: Token[] }).tokens;
          if (!nested) return (token as { text?: string }).text ?? "";
          // Blocks hold inline tokens, except quotes, which hold blocks.
          return token.type === "blockquote"
            ? blocksToText(nested)
            : inlineToText(nested);
        }
      }
    })
    .filter((part) => part !== "")
    .join("\n\n");
}

function inlineToText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "link": {
          const link = token as Tokens.Link;
          return describeLink(inlineToText(link.tokens), link.href);
        }
        case "image": {
          const image = token as Tokens.Image;
          return describeLink(image.text, image.href);
        }
        case "br":
          return "\n";
        case "checkbox":
          return (token as Tokens.Checkbox).checked ? "☑ " : "☐ ";
        default: {
          const nested = (token as { tokens?: Token[] }).tokens;
          return nested
            ? inlineToText(nested)
            : decodeEntities((token as { text?: string }).text ?? "");
        }
      }
    })
    .join("");
}

function describeLink(text: string, href: string) {
  const label = text.trim();
  if (!label || label === href || `mailto:${label}` === href) return href;
  return `${label} (${href})`;
}

// Marked escapes the text it tokenizes the way it would render it.
function decodeEntities(text: string) {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
