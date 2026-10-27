import { getDomain } from "tldts";

// Click-tracking and link-scanning hosts that rewrite every link in a message,
// so their destination can't be compared with the text. Newsletters sent
// through them would otherwise flag every link. Kept to the common ones.
const REDIRECT_HOSTS = [
  "awstrack.me", // Amazon SES
  "exct.net", // Salesforce Marketing Cloud
  "list-manage.com", // Mailchimp
  "mandrillapp.com", // Mandrill
  "safelinks.protection.outlook.com", // Microsoft Defender Safe Links
  "sendgrid.net", // SendGrid
  "urldefense.com", // Proofpoint
];

// Real top-level domains that are more often a file name ("README.md") than
// an address, so bare text ending in one is not read as a host.
const FILE_NAME_SUFFIXES = new Set(["md", "mov", "py", "rs", "sh", "zip"]);

const MAX_LINK_TEXT_LENGTH = 2048;
const SCHEME = /^https?:\/\//i;
// A host label, an optional path, query or fragment, and nothing else.
const BARE_HOST = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}(?:[/?#]\S*)?$/u;
const WRAPPING_PUNCTUATION = /^[\s<("'[]+|[\s>)"'\].,;:!?]+$/g;

/**
 * The host a link really goes to, when its visible text is a different
 * address: text that reads as a host or http(s) URL whose registrable domain
 * (the public suffix list's "example.co.uk", private suffixes such as
 * github.io included) differs from the href's. Both sides go through the URL
 * parser, so Unicode and punycode spellings of one name compare equal, while a
 * look-alike name in another script is a different domain. Hosts are returned
 * in punycode, which shows such look-alikes. Links that aren't http(s), such as
 * mailto: and tel:, and links through a known redirect host are never flagged.
 */
export function getMismatchedLinkHost(text: string, href: string) {
  const destination = parseHttpUrl(href);
  if (!destination) return null;
  const shown = parseShownHost(text);
  if (!shown) return null;

  const destinationHost = destination.hostname;
  if (REDIRECT_HOSTS.some((host) => isHostOrSubdomain(destinationHost, host))) {
    return null;
  }

  const shownDomain = getRegistrableDomain(shown);
  const destinationDomain = getRegistrableDomain(destinationHost);
  if (!shownDomain || !destinationDomain) return null;
  return shownDomain === destinationDomain ? null : destinationHost;
}

function parseShownHost(text: string) {
  if (!text || text.length > MAX_LINK_TEXT_LENGTH || !text.includes("."))
    return null;
  const candidate = text.trim().replace(WRAPPING_PUNCTUATION, "");
  if (SCHEME.test(candidate)) return parseHttpUrl(candidate)?.hostname ?? null;

  // An email address is a mailbox, not where the link says it goes.
  if (!BARE_HOST.test(candidate) || candidate.includes("@")) return null;
  const host = parseHttpUrl(`https://${candidate}`)?.hostname;
  if (!host) return null;
  const isBareName = !/[/?#]/.test(candidate) && !host.startsWith("www.");
  if (
    isBareName &&
    FILE_NAME_SUFFIXES.has(host.slice(host.lastIndexOf(".") + 1))
  )
    return null;
  return host;
}

function parseHttpUrl(value: string) {
  const absolute = value.startsWith("//") ? `https:${value}` : value;
  if (!SCHEME.test(absolute)) return null;
  try {
    const url = new URL(absolute);
    return url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

function getRegistrableDomain(host: string) {
  return getDomain(host, { allowPrivateDomains: true });
}

function isHostOrSubdomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}
