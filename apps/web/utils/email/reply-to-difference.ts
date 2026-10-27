import { getDomain } from "tldts";
import type { ParsedMessageHeaders } from "@/utils/types";
import {
  extractDomainFromEmail,
  extractEmailAddress,
  extractEmailAddresses,
  extractNameFromEmail,
} from "@/utils/email";

/**
 * The Reply-To addresses of a message that sit outside its sender's
 * organization, which is how a reply gets quietly redirected to someone the
 * thread never showed. Domains are compared by registrable domain from the
 * public suffix list (private suffixes count, as in sender authentication), so
 * mail.supplier.com and support.supplier.com match while supplier.co.uk and
 * other.co.uk, or alice.github.io and mallory.github.io, do not. Case is
 * ignored. A domain the list can't place is compared whole, and one that
 * can't be read at all never counts as the sender's.
 */
export function getReplyToDifference(
  headers: Pick<ParsedMessageHeaders, "from" | "reply-to">,
): {
  addresses: string[];
  /** The From display name, or its address when it has none. */
  sender: string;
  /** The From header as a recipient, to reply to instead. */
  senderRecipient: string;
} | null {
  const replyTo = headers["reply-to"];
  const senderAddress = extractEmailAddress(headers.from).toLowerCase();
  if (!replyTo || !senderAddress) return null;

  const senderOrganization = organizationOf(senderAddress);
  const addresses = [
    ...new Set(
      extractEmailAddresses(replyTo)
        .map((address) => address.toLowerCase())
        .filter((address) => {
          const organization = organizationOf(address);
          return (
            !organization ||
            !senderOrganization ||
            organization !== senderOrganization
          );
        }),
    ),
  ];
  if (!addresses.length) return null;

  return {
    addresses,
    sender: extractNameFromEmail(headers.from.trim()) || senderAddress,
    senderRecipient: headers.from.trim(),
  };
}

function organizationOf(address: string) {
  const domain = extractDomainFromEmail(address).toLowerCase();
  return getDomain(domain, { allowPrivateDomains: true }) ?? domain;
}
