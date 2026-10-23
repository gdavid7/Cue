import type { SenderHistory } from "./queries";

// The reader's "New address, familiar name" line. Reply-To and
// Authentication-Results are not stored locally, so this compares only the
// From name with the From address and the user's own mail history. It is not
// a spoofing, SPF or DMARC check and must never be described as protection.

export type SenderNotice =
  | {
      /** A name the user writes to, from an address they never wrote to. */
      kind: "familiar-name";
      name: string;
      address: string;
      knownAddress: string;
    }
  | {
      /** A display name that is itself an address on another domain. */
      kind: "address-name";
      name: string;
      address: string;
    };

/**
 * What, if anything, the reader should say about a received message's
 * sender. `history` comes from the local store when `needsSenderHistory`
 * asked for it; `isAllowed` holds pairs the user said are fine, keyed by
 * `senderAllowKey`.
 */
export function findSenderNotice({
  name,
  address,
  ownAddresses,
  history,
  isAllowed,
}: {
  name: string;
  address: string;
  ownAddresses: readonly string[];
  history: SenderHistory | undefined;
  isAllowed: (key: string) => boolean;
}): SenderNotice | null {
  const from = normalizeAddress(address);
  if (!from || isOwn(from, ownAddresses)) return null;
  if (isAllowed(senderAllowKey(name, from))) return null;

  const named = normalizeAddress(unquote(name));
  if (named && EMAIL.test(named)) {
    return sameDomain(domainOf(named), domainOf(from))
      ? null
      : { kind: "address-name", name: unquote(name), address: from };
  }

  // An address that has written before, such as a colleague's personal
  // one, isn't new to the user even if they never wrote back.
  if (
    !personNameKey(name) ||
    !history?.ready ||
    history.writtenTo ||
    history.receivedBefore ||
    !history.knownAddress
  )
    return null;
  return {
    kind: "familiar-name",
    name: unquote(name),
    address: from,
    knownAddress: history.knownAddress,
  };
}

/** Whether `findSenderNotice` needs this sender's history from the store. */
export function needsSenderHistory(
  name: string,
  address: string,
  ownAddresses: readonly string[],
) {
  const from = normalizeAddress(address);
  return Boolean(from && personNameKey(name) && !isOwn(from, ownAddresses));
}

/**
 * A display name as the familiar-name check compares it: case, spacing,
 * punctuation and accents folded. Null for a name too short to tell people
 * apart (a lone first name, or initials) and for one that is an address.
 *
 * Folding only removes combining marks and case. Word order ("Smith, John"
 * vs "John Smith"), nicknames, transliteration across scripts, letters that
 * don't decompose (ß, ø, ł) and look-alike characters from other scripts
 * (Cyrillic "а" for Latin "a") are not matched, so such names are treated as
 * different people: the line stays quiet rather than guessing.
 */
export function personNameKey(name: string): string | null {
  if (name.includes("@")) return null;
  const tokens = foldPersonName(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
  return tokens.length >= 2 ? tokens.join(" ") : null;
}

/** Lowercase with accents removed, so "José" and "jose" are one name. */
export function foldPersonName(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The key a "this sender is fine" choice is kept under: one name, one address. */
export function senderAllowKey(name: string, address: string) {
  const nameKey = personNameKey(name) ?? unquote(name).toLowerCase();
  return `${nameKey}\u0000${normalizeAddress(address)}`;
}

const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u;

function isOwn(address: string, ownAddresses: readonly string[]) {
  const normalized = normalizeAddress(address);
  return ownAddresses.some((own) => normalizeAddress(own) === normalized);
}

// A company's mail often comes from a subdomain of the one in its name.
function sameDomain(a: string, b: string) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function domainOf(address: string) {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * An address as every part of the sender check compares it. Takes a bare
 * address; `normalizeImportantPersonAddress` builds on this to also accept a
 * `Name <address>` header and reject what isn't an address.
 */
export function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function unquote(name: string) {
  return name
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}
