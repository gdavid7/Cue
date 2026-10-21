// What a message's text must never show: HTML entities or tags that leaked
// into it (DR-6 showed "I&#x27;m"). Returns the kinds found, never the text,
// because the health report is public.
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
