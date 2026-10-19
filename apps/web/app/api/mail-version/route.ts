import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { readKeyForOwnedAccounts } from "@/utils/redis/account-validation";
import { localMailVersionKey } from "@/utils/redis/local-mail-hints";

// A browser asks for every account it keeps mail for at once.
const MAX_ACCOUNTS = 20;

export type MailVersionResponse = Awaited<ReturnType<typeof getVersions>>;

/**
 * Whether the provider has reported changes, for a browser with no mail
 * stream open. One Redis read answers it, and an unchanged answer is a 304,
 * so a hidden tab can ask every minute and sync only the accounts that moved.
 */
export const GET = withAuth("mail-version", async (request) => {
  const emailAccountIds = [
    ...new Set(
      (new URL(request.url).searchParams.get("emailAccountIds") ?? "")
        .split(",")
        .filter(Boolean),
    ),
  ];
  if (emailAccountIds.length === 0 || emailAccountIds.length > MAX_ACCOUNTS) {
    return NextResponse.json(
      { error: `Between 1 and ${MAX_ACCOUNTS} email account IDs are required` },
      { status: 400 },
    );
  }

  let result: MailVersionResponse;
  try {
    result = await getVersions(request.auth.userId, emailAccountIds);
  } catch {
    // The browser syncs its accounts directly while this is unavailable.
    return NextResponse.json(
      { error: "Mail versions are unavailable" },
      { status: 503 },
    );
  }

  const etag = `"${emailAccountIds
    .map((id) => (id in result.versions ? (result.versions[id] ?? "-") : "x"))
    .join(",")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  return NextResponse.json(result, { headers });
});

async function getVersions(userId: string, emailAccountIds: string[]) {
  const owned = await readKeyForOwnedAccounts({
    userId,
    emailAccountIds,
    keyFor: localMailVersionKey,
  });
  // Changes whenever the provider reports a change; null before any push.
  // Unowned accounts are left out.
  const versions: Record<string, string | null> = {};
  for (const [emailAccountId, version] of owned)
    versions[emailAccountId] = version == null ? null : String(version);
  return { versions };
}
