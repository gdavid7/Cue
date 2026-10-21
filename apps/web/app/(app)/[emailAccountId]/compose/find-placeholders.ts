import { SNIPPET_VARIABLE_TOKENS } from "@/utils/snippets/expand-snippet";

const MAX_PLACEHOLDER_LENGTH = 60;
// Runs inside the Send click, so a very long message is only read this far.
const MAX_SCANNED_LENGTH = 50_000;

// Shapes only, no word lists, so this works in any language that has upper and
// lower case. Plain-text bracket forms are limited to ones a person types as a
// stand-in: a capitalised label like [Name] or [Your Company], never [1], [sic],
// [...], [Q3], a Markdown link or an all-caps banner like [EXTERNAL]. Every
// repeat is bounded so a long unbroken run of text cannot make the scan slow.
const SKIPPED = [
  /`[^`\n]{0,200}`/u,
  /(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww][Ww][Ww]\.)[^\s<>]{1,2000}/u,
  /[^\s<>@]{1,64}@[^\s<>]{1,255}/u,
];

const PLACEHOLDERS = [
  // The variables the app's own snippets fill in, left unfilled.
  new RegExp(
    `\\{(?:${SNIPPET_VARIABLE_TOKENS.map(anyCase).join("|")})\\}`,
    "u",
  ),
  /\{\{\s{0,5}[\p{L}_][\p{L}\p{N}_. -]{0,40}?\s{0,5}\}\}/u,
  /\[(?:\p{Lu}\p{Ll}\p{L}{1,39}|\p{Lu}\p{L}{1,19}(?:[ _]\p{Lu}\p{L}{0,19}){1,2})\](?!\()/u,
  // A blank to fill reads as words or a capitalised label. A lone lowercase
  // word is more likely a tag or a generic type, as in <b> or Promise<void>.
  /(?<![\p{L}\p{N}])<(?:\p{Lu}\p{L}{1,38}|\p{L}[\p{L}]{0,19}(?: \p{L}{1,19}){1,3})>/u,
  // Standalone only: not part of a mask like XXX-1234 or XXXX-XXXX.
  /(?<![\p{L}\p{N}_-])(?:X{3,}|TBD)(?![\p{L}\p{N}_-])/u,
];

const SCANNER = new RegExp(
  [...SKIPPED, ...PLACEHOLDERS]
    .map((pattern) => `(${pattern.source})`)
    .join("|"),
  "gu",
);

/** Every stand-in in the text, as written, with where it starts. */
export function findPlaceholderMatches(text: string) {
  const matches: { text: string; index: number }[] = [];
  for (const match of text.slice(0, MAX_SCANNED_LENGTH).matchAll(SCANNER)) {
    // The skipped shapes come first in the pattern, so a match in one of them
    // owns the text and nothing inside it is looked at again.
    if (match.slice(1).findIndex(Boolean) < SKIPPED.length) continue;
    if (match[0].length > MAX_PLACEHOLDER_LENGTH) continue;
    matches.push({ text: match[0], index: match.index });
  }
  return matches;
}

/**
 * Stand-ins left in a message ("{name}", "[Your Company]", "<insert date>",
 * "TBD") in the order written, each once. Skips URLs, email addresses and
 * inline code.
 */
export function findPlaceholders(text: string) {
  return [
    ...new Set(
      findPlaceholderMatches(text.normalize("NFC")).map(({ text }) => text),
    ),
  ];
}

// Snippets match their variables in any case, but XXX and TBD only in capitals,
// so the scanner as a whole stays case-sensitive.
function anyCase(token: string) {
  return [...token].map((char) => `[${char}${char.toUpperCase()}]`).join("");
}
