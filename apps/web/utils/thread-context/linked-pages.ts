import { createHash } from "node:crypto";
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
// Campaign and recipient tags mail tools add to ordinary links; dropped
// before reading so they neither block the link nor reach the crawler.
const CAMPAIGN_PARAM =
  /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;
// A piece of a path segment this long that mixes letters and digits is a
// generated token (a magic link, an invite, a verification), not a page name.
const TOKEN_PIECE_MIN_LENGTH = 16;
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
 * candidates: an event page, a job posting, a public doc. Cached by a hash of
 * the URL, so each page is fetched about once a day however often the thread
 * is opened.
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
 * the sender's own sign-in or account pages are dropped, and so is any link
 * that may carry a secret, since reading it hands it to a third-party crawler
 * whose visit can also redeem a one-time link. The rules read only URL
 * structure, so they work in any language.
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
    if (!url || unsubscribe.has(href)) continue;
    for (const name of [...url.searchParams.keys()]) {
      if (CAMPAIGN_PARAM.test(name)) url.searchParams.delete(name);
    }
    if (isNoise(url, senderDomain) || mayCarrySecret(url)) continue;
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
  const key = `linked-page:${createHash("sha256").update(url).digest("hex")}`;
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

// Public pages rarely need a query; tokens, codes, meeting passcodes and
// signatures live there, or in a fragment the page's script reads.
function mayCarrySecret(url: URL) {
  if (url.search) return true;
  if (url.hash.includes("=")) return true;
  return url.pathname.split("/").some(isTokenSegment);
}

function isTokenSegment(segment: string) {
  const pieces = segment.split(/[-_.~]/);
  if (
    pieces.some(
      (piece) =>
        piece.length >= TOKEN_PIECE_MIN_LENGTH &&
        /\d/.test(piece) &&
        /[a-z]/i.test(piece),
    )
  ) {
    return true;
  }
  // UUIDs and hex tokens split by separators; joined, an article slug
  // never reads as hex digits only.
  const joined = pieces.join("");
  return (
    joined.length >= TOKEN_PIECE_MIN_LENGTH &&
    /^[0-9a-f]+$/i.test(joined) &&
    /\d/.test(joined) &&
    /[a-f]/i.test(joined)
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
