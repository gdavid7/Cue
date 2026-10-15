import { Marked, type MarkedExtension, type Token, type Tokens } from "marked";
import { escapeHtml } from "./email-profile";
import { toEmailStyledHtml } from "./email-styles";

// Markdown's block structure, the part that plain text never has by accident.
// Inline emphasis alone is not enough: "*" and "_" show up in ordinary text.
const FENCED_CODE = /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/mu;
const HEADING = /^#{1,6}[ \t]+\S/mu;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\S/gmu;
const TABLE =
  /^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/mu;
const LINK = /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/u;

const MARKDOWN_OPTIONS: MarkedExtension = {
  async: false,
  breaks: true,
  gfm: true,
  // Only the explicit forms. In pasted email a line over "--" is a
  // signature and an indented paragraph is just indented, not a heading or
  // code. Returning undefined skips marked's built-in rule.
  tokenizer: {
    code: () => undefined,
    lheading: () => undefined,
  },
  renderer: {
    // Raw HTML in pasted text is text the person wants to show, not markup.
    html: ({ text }) => escapeHtml(text),
    // Checkboxes are form controls, which mail clients drop.
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
  },
};

const markdown = new Marked(MARKDOWN_OPTIONS);

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
const markdownWithoutImages = new Marked(MARKDOWN_OPTIONS, {
  renderer: {
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

function describeLink(text: string, rawHref: string) {
  // Bidi controls would let ".../\u202Egnp.exe" read as ".../exe.png", so the
  // address shows them percent-encoded, as a browser's address bar does.
  const href = rawHref.replace(BIDI_CONTROLS, (character) =>
    encodeURIComponent(character),
  );
  const label = text.trim();
  if (!label || label === rawHref || `mailto:${label}` === rawHref) return href;
  return `${label} (${href})`;
}

// Marked keeps character references in the text it tokenizes; the draft shows
// the characters they stand for.
function decodeEntities(text: string) {
  return text.replace(
    /&(?:#(\d{1,7})|#x([\da-f]{1,6})|(lt|gt|quot|amp|apos));/giu,
    (reference, decimal, hex, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? reference;
      const codePoint = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10_ff_ff
        ? String.fromCodePoint(codePoint)
        : reference;
    },
  );
}

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};
