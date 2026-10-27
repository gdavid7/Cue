// Full tldts (about 47 KB gzip on the reader route) rather than tldts-icann
// (about 30 KB, 66% of it): private suffixes such as github.io keep
// alice.github.io and mallory.github.io apart, which the smaller build can't.
import { getDomain, parse } from "tldts";

// Click-tracking and link-scanning hosts that rewrite every link in a message,
// so their destination can't be compared with the text. Newsletters sent
// through them would otherwise flag every link. Skipping them avoids that
// noise; it is not a safety guarantee, since anyone can send through an ESP.
// Kept to the common ones.
const REDIRECT_HOSTS = [
  "awstrack.me", // Amazon SES
  "exct.net", // Salesforce Marketing Cloud
  "list-manage.com", // Mailchimp
  "mandrillapp.com", // Mandrill
  "sendgrid.net", // SendGrid
  "urldefense.com", // Proofpoint
];

// Microsoft Defender Safe Links keeps the original address in `url`, so the
// link is judged by that address instead.
const SAFE_LINKS_HOST = "safelinks.protection.outlook.com";

// Real top-level domains that are more often a file name ("README.md") than
// an address, so bare text ending in one is not read as a host.
const FILE_NAME_SUFFIXES = new Set(["md", "mov", "py", "rs", "sh", "zip"]);

const MAX_LINK_TEXT_LENGTH = 2048;
// Relative hrefs resolve against this, so they can be told apart.
const RELATIVE_BASE_HOST = "base.invalid";
const RELATIVE_BASE = `https://${RELATIVE_BASE_HOST}/`;
const SCHEME = /^https?:\/\//i;
// Zero-width spaces, soft hyphens and other invisible characters that would
// split a name the reader still sees whole.
const FORMAT_CHARACTERS = /\p{Cf}/gu;
// A host label, an optional path, query or fragment, and nothing else.
const BARE_HOST = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}(?:[/?#]\S*)?$/u;
const WRAPPING_PUNCTUATION = /^[\s<("'[]+|[\s>)"'\].,;:!?]+$/g;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * The host a link really goes to, when its visible text is a different
 * address: text that reads as a host or http(s) URL whose registrable domain
 * (the public suffix list's "example.co.uk", private suffixes such as
 * github.io included) differs from the href's, or whose href goes to an IP
 * address. The href is resolved the way a browser resolves it. Both sides go
 * through the URL parser, so Unicode and punycode spellings of one name
 * compare equal, while a look-alike name in another script is a different
 * domain. Hosts are returned in punycode, which shows such look-alikes. Links
 * that aren't http(s), such as mailto: and tel:, relative links, and links
 * through a known redirect host are never flagged.
 */
export function getMismatchedLinkHost(
  text: string,
  href: string,
): string | null {
  const destination = parseHref(href);
  if (!destination) return null;

  const destinationHost = destination.hostname;
  if (isHostOrSubdomain(destinationHost, SAFE_LINKS_HOST)) {
    const original = destination.searchParams.get("url");
    return original ? getMismatchedLinkHost(text, original) : null;
  }
  if (REDIRECT_HOSTS.some((host) => isHostOrSubdomain(destinationHost, host))) {
    return null;
  }

  const shown = parseShownHost(text);
  if (!shown) return null;
  if (isIpAddress(destinationHost)) return destinationHost;

  const shownDomain = getRegistrableDomain(shown);
  const destinationDomain = getRegistrableDomain(destinationHost);
  if (!shownDomain || !destinationDomain) return null;
  return shownDomain === destinationDomain ? null : destinationHost;
}

function parseShownHost(text: string) {
  if (!text || text.length > MAX_LINK_TEXT_LENGTH) return null;
  const candidate = text
    .replace(FORMAT_CHARACTERS, "")
    .trim()
    .replace(WRAPPING_PUNCTUATION, "");
  if (!candidate.includes(".")) return null;
  if (SCHEME.test(candidate)) return parseHref(candidate)?.hostname ?? null;

  // An email address is a mailbox, not where the link says it goes.
  if (!BARE_HOST.test(candidate) || candidate.includes("@")) return null;
  const host = parseHref(`https://${candidate}`)?.hostname;
  if (!host) return null;

  // "report.pdf" and "Node.js" end in a suffix no registry hands out.
  const { isIcann, isPrivate } = parse(host, { allowPrivateDomains: true });
  if (!isIcann && !isPrivate) return null;
  const isBareName = !/[/?#]/.test(candidate) && !host.startsWith("www.");
  if (
    isBareName &&
    FILE_NAME_SUFFIXES.has(host.slice(host.lastIndexOf(".") + 1))
  )
    return null;
  return host;
}

function parseHref(value: string) {
  try {
    const url = new URL(value, RELATIVE_BASE);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === RELATIVE_BASE_HOST) return null;
    return url;
  } catch {
    return null;
  }
}

function isIpAddress(host: string) {
  return host.startsWith("[") || IPV4.test(host);
}

function getRegistrableDomain(host: string) {
  return getDomain(host, { allowPrivateDomains: true });
}

function isHostOrSubdomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}
