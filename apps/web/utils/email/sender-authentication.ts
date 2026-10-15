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
  if (!header || !fromDomain) return false;

  const [authservId, ...clauses] = withoutCommentsOrQuotes(header)
    .split(";")
    .map(parseClause);
  if (authservId?.method !== TRUSTED_AUTHSERV_ID) return false;

  const dmarc = clauses.find((clause) => clause.method === "dmarc");
  if (dmarc) {
    return dmarc.result === "pass" && dmarc.props["header.from"] === fromDomain;
  }
  return clauses.some((clause) => {
    if (clause.method !== "dkim" || clause.result !== "pass") return false;
    const signer =
      clause.props["header.d"] ?? clause.props["header.i"]?.split("@").at(-1);
    return !!signer && sameOrganization(signer, fromDomain);
  });
}

/**
 * The header with comments (which may nest) and quoted strings removed, so
 * text the sender chose, such as a quoted envelope address Gmail echoes, can't
 * read as a result of its own.
 */
function withoutCommentsOrQuotes(header: string) {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (char === "\\" && (quoted || depth > 0)) {
      i++;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += '""';
    } else if (char === "(") {
      depth = 1;
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
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
