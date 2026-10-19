import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";

const word = (value: string): SearchNode => ({
  kind: "text",
  value,
  exact: false,
});
const phrase = (value: string): SearchNode => ({
  kind: "text",
  value,
  exact: true,
});
const op = (
  name: string,
  value: string,
  options: { quoted?: boolean; comparator?: string } = {},
): SearchNode => ({
  kind: "operator",
  name,
  comparator: (options.comparator ?? ":") as ":",
  value,
  quoted: options.quoted ?? false,
});
const and = (...children: SearchNode[]): SearchNode => ({
  kind: "and",
  children,
});
const or = (...children: SearchNode[]): SearchNode => ({
  kind: "or",
  children,
});
const not = (child: SearchNode): SearchNode => ({ kind: "not", child });

describe("parseSearchQuery", () => {
  it.each<[string, SearchNode]>([
    ["invoice", word("invoice")],
    ["offer letter", and(word("offer"), word("letter"))],
    ['"offer letter"', phrase("offer letter")],
    ["+unicorn", phrase("unicorn")],
    ["from:amy@example.com", op("from", "amy@example.com")],
    ["FROM:Amy", op("from", "Amy")],
    ['subject:"next steps"', op("subject", "next steps", { quoted: true })],
    ["cc:ada bcc:grace", and(op("cc", "ada"), op("bcc", "grace"))],
    ["is:unread in:inbox", and(op("is", "unread"), op("in", "inbox"))],
    ["label:my-label", op("label", "my-label")],
    ["after:2024/01/31", op("after", "2024/01/31")],
    ["before:2024-01-31", op("before", "2024-01-31")],
    ["newer_than:2d", op("newer_than", "2d")],
    ["larger:10M", op("larger", "10M")],
    ["filename:pdf", op("filename", "pdf")],
    ["has:drive", op("has", "drive")],
    // Outlook's KQL comparisons, as Cue's Outlook search form writes them.
    ["size>1MB", op("size", "1MB", { comparator: ">" })],
    [
      "received>=2024-01-31",
      op("received", "2024-01-31", { comparator: ">=" }),
    ],
    ["hasattachments:true", op("hasattachments", "true")],
    // Negation.
    ["-newsletter", not(word("newsletter"))],
    ["-from:x@y.com", not(op("from", "x@y.com"))],
    ['-"weekly digest"', not(phrase("weekly digest"))],
    ["NOT spam", not(word("spam"))],
    ["-(a b)", not(and(word("a"), word("b")))],
    // Alternatives: OR binds tighter than the implicit AND, as in Gmail.
    ["a OR b", or(word("a"), word("b"))],
    ["a OR b OR c", or(word("a"), word("b"), word("c"))],
    ["x a OR b", and(word("x"), or(word("a"), word("b")))],
    ["{a b}", or(word("a"), word("b"))],
    ["from:amy OR from:bob", or(op("from", "amy"), op("from", "bob"))],
    // Grouping.
    ["(a b) c", and(word("a"), word("b"), word("c"))],
    ["(a OR b) c", and(or(word("a"), word("b")), word("c"))],
    [
      "subject:(dinner movie)",
      and(op("subject", "dinner"), op("subject", "movie")),
    ],
    ["from:{amy bob}", or(op("from", "amy"), op("from", "bob"))],
    ["from:(amy OR bob)", or(op("from", "amy"), op("from", "bob"))],
    [
      "(from:amy@x.com) (to:bob@x.com)",
      and(op("from", "amy@x.com"), op("to", "bob@x.com")),
    ],
    // Operators inside quotes are part of the phrase.
    ['"sent to:grace"', phrase("sent to:grace")],
    ['"invoice (paid)"', phrase("invoice (paid)")],
    // Not operators: words, as they are to Gmail.
    ["re:meeting", word("re:meeting")],
    ["https://example.com/a", word("https://example.com/a")],
    ["from:", word("from:")],
    ["or and", and(word("or"), word("and"))],
    ["ANDROID", word("ANDROID")],
    // Explicit AND is the implicit one.
    ["a AND b", and(word("a"), word("b"))],
    // Proximity is kept whole for the provider.
    [
      "holiday AROUND 10 vacation",
      { kind: "around", text: "holiday AROUND 10 vacation" },
    ],
    // Stray brackets and dangling keywords are noise.
    ["a ) b", and(word("a"), word("b"))],
    ["(a b", and(word("a"), word("b"))],
    ["OR a", word("a")],
    ["a OR", word("a")],
    ['"unclosed phrase', phrase("unclosed phrase")],
    ["", and()],
    ["   ", and()],
  ])("parses %j", (query, expected) => {
    expect(parseSearchQuery(query)).toEqual(expected);
  });

  it("survives deep nesting without exhausting the stack", () => {
    const query = `${"(".repeat(5000)}a${")".repeat(5000)}`;
    expect(parseSearchQuery(query)).toEqual(word("a"));
  });
});
