import { getDomain } from "tldts";
import { extractEmailAddress } from "@/utils/email";
import type { ParsedMessageHeaders } from "@/utils/types";

// Only Gmail's own verdict counts; any other server's could be the sender's.
const TRUSTED_AUTHSERV_ID = "mx.google.com";

/**
 * Whether the domain in the message's From address was authenticated when
 * it arrived: Gmail recorded a DMARC pass for that domain, or a DKIM pass
 * for a domain in the same organization. SPF alone checks the envelope
 * sender, which needn't match From, so it doesn't count. A message without
 * Gmail's verdict (e.g. from Outlook) is never authenticated.
 */
export function isAuthenticatedSender(message: {
  headers: Pick<ParsedMessageHeaders, "from" | "authentication-results">;
}): boolean {
  const results = message.headers["authentication-results"];
  const fromDomain = extractEmailAddress(message.headers.from)
    .split("@")[1]
    ?.toLowerCase();
  if (!results || !fromDomain) return false;
  const [authservId, ...clauses] = results.split(";").map((s) => s.trim());
  if (authservId?.split(/\s+/)[0]?.toLowerCase() !== TRUSTED_AUTHSERV_ID)
    return false;

  return clauses.some((clause) => {
    const lower = clause.toLowerCase();
    if (lower.startsWith("dmarc=pass")) {
      return property(lower, "header.from") === fromDomain;
    }
    if (lower.startsWith("dkim=pass")) {
      const signer =
        property(lower, "header.d") ??
        property(lower, "header.i")?.split("@").at(-1);
      return !!signer && sameOrganization(signer, fromDomain);
    }
    return false;
  });
}

function property(clause: string, name: string) {
  const escaped = name.replace(".", "\\.");
  return new RegExp(`(?:^|\\s)${escaped}=([^\\s;]+)`).exec(clause)?.[1];
}

function sameOrganization(a: string, b: string) {
  const orgA = getDomain(a);
  return !!orgA && orgA === getDomain(b);
}
