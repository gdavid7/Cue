import "server-only";
import freeEmailDomains from "free-email-domains";
import { getDomain, getPublicSuffix } from "tldts";
import { extractDomainFromEmail, isPublicEmailDomain } from "@/utils/email";

// Several thousand free and disposable mailbox providers, kept server-side:
// the list is too large for the client bundle that imports @/utils/email.
const MAILBOX_PROVIDERS = new Set<string>(freeEmailDomains);

/**
 * Whether two addresses belong to one organization that vouches for its
 * people: the same registrable domain (private suffixes such as github.io
 * count, so names under one stay apart), and not a domain anyone can get an
 * address at. Mailbox providers never count, and neither do universities
 * (.edu, .edu.<cc>, .ac.<cc>): every student shares the domain.
 */
export function isSameOrganization(a: string, b: string): boolean {
  const org = organizationOf(a);
  return !!org && org === organizationOf(b);
}

function organizationOf(email: string): string | null {
  const domain = extractDomainFromEmail(email).toLowerCase();
  const org = getDomain(domain, { allowPrivateDomains: true });
  if (!org || isMailboxProvider(domain) || isMailboxProvider(org)) return null;
  const suffix = getPublicSuffix(org) ?? "";
  const academic =
    suffix === "edu" || suffix.startsWith("edu.") || suffix.startsWith("ac.");
  return academic ? null : org;
}

function isMailboxProvider(domain: string) {
  return isPublicEmailDomain(domain) || MAILBOX_PROVIDERS.has(domain);
}
