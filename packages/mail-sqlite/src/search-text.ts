import type { MessageAttachmentDescriptor } from "@inboxzero/mail-core/messages";
import { stemmer } from "stemmer";

// Text written to and matched against message_fts. The index and the query
// must be prepared the same way, so both sides go through this module.

export function searchableBody(content: {
  text: string | null;
  html: string | null;
}): string {
  // Some senders ship an empty text part next to the real HTML body.
  if (content.text?.trim()) return searchableText(content.text);
  if (content.html) return searchableText(htmlToSearchText(content.html));
  return "";
}

// unicode61 splits "Wi-Fi" into "wi" and "fi", so each hyphenated compound
// is also indexed joined ("wifi") at the end of the text, where it can't
// break a phrase match across the words around it.
export function searchableText(value: string): string {
  const joined = new Set<string>();
  for (const [compound] of value.matchAll(HYPHENATED)) {
    if (joined.size === MAX_JOINED_COMPOUNDS) break;
    if (compound.length <= MAX_COMPOUND_LENGTH)
      joined.add(compound.replace(HYPHENS, ""));
  }
  return spaceUnspacedScripts(
    joined.size ? `${value} ${[...joined].join(" ")}` : value,
  );
}

// A real attachment's file name, and its type when that is a short format
// name such as pdf or jpeg. Inline images such as signature logos are left
// out: they aren't what someone searching for an attachment means.
export function searchableAttachments(
  attachments: Pick<
    MessageAttachmentDescriptor,
    "filename" | "mimeType" | "inline"
  >[],
): string {
  return attachments
    .filter((attachment) => !attachment.inline)
    .flatMap((attachment) => {
      const format = attachment.mimeType.toLowerCase().split("/")[1] ?? "";
      return [
        searchableText(attachment.filename),
        ...(FORMAT_NAME.test(format) ? [format] : []),
      ];
    })
    .join(" ");
}

// Builds an FTS5 query where each term, or the whole phrase, is one quoted
// string: quoting makes FTS5 read operators, column filters, and punctuation
// as plain text, and the trailing * matches words as they are being typed.
// A term also matches other forms of its word (see stemPrefix), a hyphenated
// term also matches written as one word, the way a joined compound is
// indexed, and two words also match as that one whole word. Resolves null
// when nothing in the input can match an indexed token.
export function searchMatchQuery(
  value: string,
  match: "term" | "phrase",
): string | null {
  const parts = (match === "phrase" ? [value] : value.split(/\s+/)).filter(
    (part) => TOKEN_CHARACTER.test(part),
  );
  if (!parts.length) return null;
  if (match === "phrase") return quoteTerm(parts[0]);
  const terms = parts.map((part) => {
    const joined = part.replace(HYPHENS, "");
    const forms = [
      stemPrefix(part) ?? quoteTerm(part),
      ...(isJoinable(part) && joined !== part ? [quoteTerm(joined)] : []),
    ];
    return forms.length > 1 ? `(${forms.join(" OR ")})` : forms[0];
  });
  if (parts.length === 2 && parts.every(isJoinable)) {
    const whole = parts.join("").replace(HYPHENS, "").replaceAll('"', "");
    return `(${terms.join(" ")}) OR "${whole}"`;
  }
  return terms.join(" ");
}

// The index keeps words as written, so the query matches the word's stem as
// a prefix, which also covers the word as typed: "invoices" also finds
// "invoice", "shipping" finds "shipped", "deliveries" finds "delivery". The
// stemmer's rules are English suffixes, which also fold plurals in other
// languages written in plain Latin letters ("facturas"); words with other
// letters are left as typed. Only a short ending is dropped, so a long
// derivation ("organizations" to "organ") falls back to dropping a plural
// "s", and a stem under four letters ("running" to "run") leaves the word as
// typed. A stem prefix still reaches words derived from it ("guide" also
// finds "guidance"), which is the price of finding the singular.
function stemPrefix(part: string): string | null {
  if (!PLAIN_LATIN_WORD.test(part)) return null;
  const word = part.toLowerCase();
  const stemmed = stemmer(word);
  // Porter spells "delivery" and "deliveries" alike as "deliveri".
  const stem =
    word.endsWith("ies") && stemmed.endsWith("i")
      ? stemmed.slice(0, -1)
      : stemmed;
  const candidate =
    word.length - stem.length > MAX_STEMMED_ENDING && PLURAL.test(word)
      ? word.slice(0, -1)
      : stem;
  if (
    candidate === word ||
    !word.startsWith(candidate) ||
    candidate.length < MIN_STEM_LENGTH ||
    word.length - candidate.length > MAX_STEMMED_ENDING
  )
    return null;
  return `"${candidate}"*`;
}

// Runs during sync for every HTML-only body, in a worker or Node process with
// no DOM, so it is a small regex pass rather than a parser: only the words
// matter here, not layout.
export function htmlToSearchText(html: string): string {
  return html
    .replace(HIDDEN_CONTENT, " ")
    .replace(TAG, (_tag, name: string | undefined) =>
      name && INLINE_TAGS.has(name.toLowerCase()) ? "" : " ",
    )
    .replace(ENTITY, decodeEntity)
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, " ")
    .trim();
}

// unicode61 splits words on spaces and punctuation, so a run of Chinese,
// Japanese, or Thai would otherwise index as one token that no word inside it
// can match. Indexing each character as a token and querying terms as
// character phrases keeps substring search working for those scripts.
function spaceUnspacedScripts(value: string): string {
  return value.replace(UNSPACED_SCRIPT, " $& ");
}

function quoteTerm(part: string): string {
  const text = spaceUnspacedScripts(part).replace(/\s+/g, " ").trim();
  // A one-character prefix expands to a large share of the vocabulary and
  // made the first keystroke the slowest search, so it matches whole words.
  const prefix = [...text].length > 1 ? "*" : "";
  return `"${text.replaceAll('"', '""')}"${prefix}`;
}

// A word, or words joined by hyphens, in a script written with spaces.
function isJoinable(part: string): boolean {
  return (
    JOINABLE.test(part) &&
    part.length <= MAX_COMPOUND_LENGTH &&
    spaceUnspacedScripts(part) === part
  );
}

// unicode61's default token characters: letters, numbers, and private use.
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{Co}]/u;

const HYPHENATED = /[\p{L}\p{N}]+(?:[-\u2010\u2011][\p{L}\p{N}]+)+/gu;
const JOINABLE = /^[\p{L}\p{N}]+(?:[-\u2010\u2011][\p{L}\p{N}]+)*$/u;
const HYPHENS = /[-\u2010\u2011]/gu;
// Bounds what a long body adds to its search row.
const MAX_JOINED_COMPOUNDS = 200;
const MAX_COMPOUND_LENGTH = 64;
const FORMAT_NAME = /^[a-z0-9]{2,4}$/;
const PLAIN_LATIN_WORD = /^[a-z]+$/i;
const PLURAL = /[^s]s$/;
const MIN_STEM_LENGTH = 4;
const MAX_STEMMED_ENDING = 4;

const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;

// Everything a <head> holds besides tags is a title, style, or script. Like
// browsers, an unclosed comment or raw-text element runs to the end of the
// document, which also keeps the scan linear on malformed mail.
const HIDDEN_CONTENT =
  /<!--[\s\S]*?(?:-->|$)|<(style|script|template|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;

const TAG = /<(?:\/?([a-zA-Z][\w:-]*)|[!?])(?:"[^"<]*"|'[^'<]*'|[^'"<>])*>/g;

// Tags that sit inside words; every other tag separates words.
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "mark",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "u",
  "wbr",
]);

const ENTITY =
  /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  iexcl: "¡",
  iquest: "¿",
  szlig: "ß",
  aelig: "æ",
  AElig: "Æ",
  oslash: "ø",
  Oslash: "Ø",
  oelig: "œ",
  OElig: "Œ",
  eth: "ð",
  ETH: "Ð",
  thorn: "þ",
  THORN: "Þ",
};

// Accented Latin letters (&eacute;, &Uuml;, &scaron;, ...) are a letter plus
// a named mark, so they are composed instead of listed one by one.
const COMBINING_MARKS: Record<string, string> = {
  grave: "\u0300",
  acute: "\u0301",
  circ: "\u0302",
  tilde: "\u0303",
  uml: "\u0308",
  ring: "\u030A",
  caron: "\u030C",
  cedil: "\u0327",
};

const ACCENTED_LETTER =
  /^([a-zA-Z])(grave|acute|circ|tilde|uml|ring|caron|cedil)$/;

function decodeEntity(
  entity: string,
  decimal: string | undefined,
  hex: string | undefined,
  name: string | undefined,
): string {
  if (decimal || hex) {
    const codePoint = decimal
      ? Number(decimal)
      : Number.parseInt(hex ?? "", 16);
    const valid =
      codePoint > 0 &&
      codePoint <= 0x10_ff_ff &&
      (codePoint < 0xd8_00 || codePoint > 0xdf_ff);
    return valid ? String.fromCodePoint(codePoint) : " ";
  }
  if (!name) return entity;
  const named = NAMED_ENTITIES[name];
  if (named !== undefined) return named;
  const accented = ACCENTED_LETTER.exec(name);
  if (!accented) return entity;
  return `${accented[1]}${COMBINING_MARKS[accented[2]]}`.normalize("NFC");
}
