import type { ContextCandidate } from "@cue/context";
import { load } from "cheerio";
import { getDomain } from "tldts";
import { extractEmailAddress } from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import { getExaContents, isExaSearchEnabled } from "@/utils/exa/search";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import type { ParsedMessage } from "@/utils/types";

const MAX_LINKS = 2;
// The same cap as any other source a suggested reply reads.
const MAX_PAGE_TEXT = 2000;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
// A path segment this long and unbroken is an encoded token, not a page name.
const OPAQUE_SEGMENT = /^[\w\-=.%~]{40,}$/;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
// Mail tools serve tracking redirects from subdomains like these.
const TRACKING_SUBDOMAINS = new Set([
  "click",
  "clicks",
  "ct",
  "e",
  "email",
  "l",
  "link",
  "links",
  "r",
  "redirect",
  "t",
  "track",
  "tracking",
  "trk",
  "url",
]);
const TRACKING_SEGMENTS = new Set([
  "click",
  "ls",
  "redirect",
  "track",
  "tracking",
  "wf",
]);
const UNSUBSCRIBE_PATH = /unsubscribe|opt-?out|email-?preferences/i;
const ACCOUNT_SEGMENTS = new Set([
  "account",
  "accounts",
  "auth",
  "login",
  "log-in",
  "myaccount",
  "my-account",
  "oauth",
  "password",
  "preferences",
  "profile",
  "settings",
  "signin",
  "sign-in",
  "sign_in",
  "sso",
]);

type LinkedPage = { title: string; text: string };

/**
 * The public pages the latest message links to, read with Exa, as context
 * candidates: an event page, a job posting, a public doc. Cached by URL, so
 * each page is fetched about once a day however often the thread is opened.
 * `complete` is false when a page could not be read this time.
 */
export async function fetchLinkedPages({
  message,
  logger,
}: {
  message: ParsedMessage;
  logger: Logger;
}): Promise<{ candidates: ContextCandidate[]; complete: boolean }> {
  if (!isExaSearchEnabled()) return { candidates: [], complete: true };
  const urls = extractMainLinks(message);
  const at = new Date(getMessageTimestamp(message)).toISOString();

  let complete = true;
  const pages = await Promise.all(
    urls.map(async (url) => {
      const page = await readPage(url, logger);
      if (!page) complete = false;
      if (!page?.text) return null;
      const domain = domainOf(url);
      return {
        id: `web:${url}`,
        kind: "web" as const,
        title: page.title || domain,
        text: page.text,
        at,
        people: [],
        url,
        source: domain,
      };
    }),
  );
  return { candidates: pages.filter((page) => page !== null), complete };
}

/**
 * The links most likely to be what the email is about, in order, at most
 * two. Links with words on them come first, then bare ones, each in the order
 * they appear; unsubscribe, tracking and redirect links, images, homepages and
 * the sender's own sign-in or account pages are dropped. The rules read only
 * URL structure, so they work in any language.
 */
export function extractMainLinks(
  message: Pick<ParsedMessage, "textHtml" | "textPlain" | "headers">,
  limit = MAX_LINKS,
): string[] {
  const unsubscribe = new Set(
    [...(message.headers["list-unsubscribe"] ?? "").matchAll(/<([^>]+)>/g)].map(
      ([, url]) => url.trim(),
    ),
  );
  const senderDomain = getDomain(
    extractEmailAddress(message.headers.from).split("@")[1] ?? "",
  );

  const seen = new Set<string>();
  const links: { url: string; hasText: boolean }[] = [];
  for (const { href, text } of linksIn(message)) {
    const url = parseUrl(href);
    if (!url || unsubscribe.has(href) || isNoise(url, senderDomain)) continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ url: url.href, hasText: !!text && text !== href });
  }
  return [...links.filter((l) => l.hasText), ...links.filter((l) => !l.hasText)]
    .slice(0, limit)
    .map((l) => l.url);
}

async function readPage(
  url: string,
  logger: Logger,
): Promise<LinkedPage | null> {
  const key = `linked-page:${url}`;
  const cached = await redis.get<LinkedPage>(key).catch(() => null);
  if (cached) return cached;
  try {
    const [result] = await getExaContents({
      urls: [url],
      maxTextCharacters: MAX_PAGE_TEXT,
      logger,
    });
    // A page Exa couldn't read is cached too, so it isn't retried on every open.
    const page = { title: result?.title ?? "", text: result?.text ?? "" };
    await redis.set(key, page, { ex: CACHE_TTL_SECONDS }).catch(() => null);
    return page;
  } catch (error) {
    logger.warn("Failed to read linked page", { error });
    return null;
  }
}

/** HTML links with their words, then URLs written out in the plain text. */
export function linksIn(
  message: Pick<ParsedMessage, "textHtml" | "textPlain">,
): { href: string; text: string }[] {
  const $ = load(message.textHtml ?? "");
  const anchors = $("a[href]")
    .toArray()
    .map((el) => ({
      href: ($(el).attr("href") ?? "").trim(),
      text: $(el).text().replace(/\s+/g, " ").trim(),
    }));
  const bare = [
    ...(message.textPlain ?? "").matchAll(/https?:\/\/[^\s<>"'()[\]]+/g),
  ].map(([match]) => ({ href: match.replace(/[.,;:!?]+$/, ""), text: "" }));
  return [...anchors, ...bare];
}

function isNoise(url: URL, senderDomain: string | null) {
  const segments = url.pathname.split("/").filter(Boolean);
  const lower = segments.map((s) => s.toLowerCase());
  if (!segments.length && !url.search) return true; // a homepage
  if (IMAGE_PATH.test(url.pathname)) return true;
  if (UNSUBSCRIBE_PATH.test(url.pathname + url.search)) return true;
  if (TRACKING_SUBDOMAINS.has(url.hostname.split(".")[0]?.toLowerCase() ?? ""))
    return true;
  if (lower.some((s) => TRACKING_SEGMENTS.has(s))) return true;
  if (segments.some((s) => OPAQUE_SEGMENT.test(s))) return true;
  // A redirect carries its destination in the query or the path.
  if ([...url.searchParams.values()].some((v) => /^https?:\/\//i.test(v)))
    return true;
  if (/\/https?(:|%3A)/i.test(url.pathname)) return true;
  return (
    !!senderDomain &&
    getDomain(url.hostname) === senderDomain &&
    lower.some((s) => ACCOUNT_SEGMENTS.has(s))
  );
}

export function parseUrl(href: string): URL | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function domainOf(url: string) {
  return new URL(url).hostname.replace(/^www\./, "");
}
