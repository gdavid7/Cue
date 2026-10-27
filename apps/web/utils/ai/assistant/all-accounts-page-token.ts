import { z } from "zod";
import { isAllowedMicrosoftGraphPageToken } from "@/utils/outlook/page-token";

// A search across several accounts continues each of them from its own
// provider's page token. They travel together in one opaque token, handed to
// the model in the tool result and never stored by the server.
const PREFIX = "accounts:";
const MAX_ACCOUNTS = 16;

const tokensSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(4096))
  .refine((tokens) => Object.keys(tokens).length <= MAX_ACCOUNTS)
  .refine((tokens) =>
    Object.values(tokens).every(isAllowedMicrosoftGraphPageToken),
  );

/** One page token that continues each listed account's search. */
export function toAllAccountsPageToken(tokens: Record<string, string>) {
  return `${PREFIX}${Buffer.from(JSON.stringify(tokens)).toString("base64url")}`;
}

/**
 * Each account's page token, by account id, when `pageToken` continues a
 * search across accounts; null for a single provider's token or no token.
 * An account missing from it has no more matches. A token that does not
 * decode continues nothing.
 */
export function parseAllAccountsPageToken(
  pageToken: string | null | undefined,
): Record<string, string> | null {
  if (!pageToken?.startsWith(PREFIX)) return null;
  return decode(pageToken) ?? {};
}

/** A page token from searchInbox: one provider's, or one across accounts. */
export const searchPageTokenSchema = z
  .string()
  .nullish()
  .refine(
    (pageToken) =>
      pageToken?.startsWith(PREFIX)
        ? decode(pageToken) !== null
        : isAllowedMicrosoftGraphPageToken(pageToken),
    { message: "Invalid page token" },
  );

function decode(pageToken: string) {
  try {
    const parsed = tokensSchema.safeParse(
      JSON.parse(
        Buffer.from(pageToken.slice(PREFIX.length), "base64url").toString(),
      ),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
