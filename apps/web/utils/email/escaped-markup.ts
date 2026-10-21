// HTML entities or tags that leaked into a message's text show up literally
// to the reader ("I&#x27;m"). Returns the kinds found, never the text, so
// callers can report them without exposing the message.
const LEAKS = [
  { name: "&#", pattern: /&#/ },
  { name: "&amp;", pattern: /&amp;/i },
  { name: "&lt;", pattern: /&lt;/i },
  { name: "&gt;", pattern: /&gt;/i },
  { name: "&quot;", pattern: /&quot;/i },
  { name: "<p>", pattern: /<\/?p[\s>/]/i },
  { name: "<br>", pattern: /<br[\s>/]/i },
];

export function findEscapedMarkup(text: string) {
  return LEAKS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => name,
  );
}
