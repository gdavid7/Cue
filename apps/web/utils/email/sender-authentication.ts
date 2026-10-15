import { getDomain } from "tldts";
import { extractEmailAddress } from "@/utils/email";
import type { ParsedMessageHeaders } from "@/utils/types";

// Only Gmail's own verdict counts; any other server's could be the sender's.
const TRUSTED_AUTHSERV_ID = "mx.google.com";

/**
 * Whether the domain in the message's From address was authenticated when
 * it arrived, by Gmail's Authentication-Results (RFC 8601). A DMARC result,
 * when there is one, decides alone: it must pass for the From domain. With
 * none, a DKIM pass from that domain or its own organization counts. SPF
 * checks the envelope sender, which needn't match From, so it never does.
 * A message without Gmail's verdict (e.g. from Outlook) is not authenticated.
 */
export function isAuthenticatedSender(message: {
  headers: Pick<ParsedMessageHeaders, "from" | "authentication-results">;
}): boolean {
  const header = message.headers["authentication-results"];
  const fromDomain = extractEmailAddress(message.headers.from)
    .split("@")[1]
    ?.toLowerCase();
  // Quoted strings are where a sender's own text appears (an envelope address
  // Gmail echoes), and quoting interacts with comments in ways that have let
  // that text read as a result. A header with any is refused, not parsed.
  if (!header || !fromDomain || header.includes('"')) return false;
  const stripped = withoutComments(header);
  if (stripped === null) return false;

  const [authservId, ...clauses] = stripped.split(";").map(parseClause);
  if (authservId?.method !== TRUSTED_AUTHSERV_ID) return false;

  const dmarc = clauses.filter((clause) => clause.method === "dmarc");
  // Gmail records one DMARC result; more means the header isn't Gmail's alone.
  if (dmarc.length > 1) return false;
  if (dmarc[0]) {
    return (
      dmarc[0].result === "pass" && dmarc[0].props["header.from"] === fromDomain
    );
  }
  return clauses.some((clause) => {
    if (clause.method !== "dkim" || clause.result !== "pass") return false;
    const signer =
      clause.props["header.d"] ?? clause.props["header.i"]?.split("@").at(-1);
    return !!signer && sameOrganization(signer, fromDomain);
  });
}

/**
 * The header with its comments (which may nest) removed, or null when they
 * don't balance: an unclosed comment would hide the rest of the header, and
 * a stray ")" means the header isn't shaped as Gmail writes it.
 */
function withoutComments(header: string): string | null {
  let out = "";
  let depth = 0;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (char === "\\" && depth > 0) {
      i++;
    } else if (char === "(") {
      if (depth === 0) out += " ";
      depth++;
    } else if (char === ")") {
      if (depth === 0) return null;
      depth--;
    } else if (depth === 0) {
      out += char;
    }
  }
  return depth === 0 ? out : null;
}

/** `method=result ptype.property=value …`; the first clause is the server id. */
function parseClause(clause: string) {
  const [head = "", ...rest] = clause.trim().toLowerCase().split(/\s+/);
  const [method, result] = head.split("=");
  const props: Record<string, string> = {};
  for (const token of rest) {
    const at = token.indexOf("=");
    if (at > 0 && !Object.hasOwn(props, token.slice(0, at))) {
      props[token.slice(0, at)] = token.slice(at + 1);
    }
  }
  return { method, result, props };
}

// Private suffixes count, so alice.github.io and mallory.github.io differ.
function sameOrganization(a: string, b: string) {
  const orgA = getDomain(a, { allowPrivateDomains: true });
  return !!orgA && orgA === getDomain(b, { allowPrivateDomains: true });
}
