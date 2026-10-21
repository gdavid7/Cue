import { SNIPPET_VARIABLE_TOKENS } from "@/utils/snippets/expand-snippet";

const MAX_PLACEHOLDER_LENGTH = 60;

// Shapes only, no word lists, so this works in any language that has upper and
// lower case. Plain-text bracket forms are limited to ones a person types as a
// stand-in: a capitalised label like [Name] or [YOUR COMPANY], never [1], [sic],
// [...], [Q3] or a Markdown link.
const SKIPPED = [
  /`[^`\n]*`/u,
  /(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww][Ww][Ww]\.)[^\s<>]+/u,
  /[^\s<>]+@[^\s<>]+/u,
];

const PLACEHOLDERS = [
  // The variables the app's own snippets fill in, left unfilled.
  new RegExp(
    `\\{(?:${SNIPPET_VARIABLE_TOKENS.map(anyCase).join("|")})\\}`,
    "u",
  ),
  /\{\{\s*[\p{L}_][\p{L}\p{N}_. -]*?\s*\}\}/u,
  /\[\p{Lu}\p{L}{2,}(?:[ _]\p{Lu}\p{L}*){0,2}\](?!\()/u,
  /<(?!\/)\p{L}[\p{L} ]{1,38}\p{L}>/u,
  /(?<![\p{L}\p{N}_])(?:X{3,}|TBD)(?![\p{L}\p{N}])/u,
];

// Tags that show up when someone writes about HTML, not as a blank to fill.
const HTML_TAGS = new Set([
  "div",
  "span",
  "html",
  "head",
  "body",
  "table",
  "img",
  "ul",
  "ol",
  "em",
  "strong",
  "code",
  "pre",
  "font",
  "blockquote",
  "center",
  "style",
  "script",
  "title",
  "form",
  "input",
  "button",
]);

const SCANNER = new RegExp(
  [...SKIPPED, ...PLACEHOLDERS]
    .map((pattern) => `(${pattern.source})`)
    .join("|"),
  "gu",
);

/**
 * Stand-ins left in a message ("{name}", "[COMPANY]", "<insert date>", "TBD")
 * in the order written, each once. Skips URLs, email addresses and inline code.
 */
export function findPlaceholders(text: string) {
  const found = new Set<string>();
  for (const match of text.normalize("NFC").matchAll(SCANNER)) {
    // The skipped shapes come first in the pattern, so a match in one of them
    // owns the text and nothing inside it is looked at again.
    const groups = match.slice(1);
    if (groups.findIndex(Boolean) < SKIPPED.length) continue;
    const placeholder = match[0];
    if (placeholder.length > MAX_PLACEHOLDER_LENGTH) continue;
    if (
      placeholder.startsWith("<") &&
      HTML_TAGS.has(placeholder.slice(1, -1).toLowerCase())
    )
      continue;
    found.add(placeholder);
  }
  return [...found];
}

// Snippets match their variables in any case, but XXX and TBD only in capitals,
// so the scanner as a whole stays case-sensitive.
function anyCase(token: string) {
  return [...token].map((char) => `[${char}${char.toUpperCase()}]`).join("");
}
