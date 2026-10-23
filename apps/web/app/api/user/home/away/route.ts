import { NextResponse } from "next/server";
import { getAwaySummary } from "@/utils/home/away-summary";
import { withAuth } from "@/utils/middleware";
import { recordLastLogin } from "@/utils/user/last-login";

export type GetAwaySummaryResponse = Awaited<ReturnType<typeof getAwaySummary>>;

// More than anyone keeps in All inboxes.
const MAX_ACCOUNTS = 20;

/**
 * Today's "While you were away": its own small request beside Today's, so
 * it never holds up the lanes. `accounts` is the comma-separated accounts
 * Today shows.
 */
export const GET = withAuth("user/home/away", async (request) => {
  const { userId } = request.auth;
  const emailAccountIds = (request.nextUrl.searchParams.get("accounts") ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, MAX_ACCOUNTS);
  // The layout records the visit after it renders, which may be after this
  // asks; recording it here first moves the last visit before it is read.
  await recordLastLogin(userId);
  const summary = await getAwaySummary({ userId, emailAccountIds });
  // Counts only, and the user's own: never kept in between.
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "private, no-store" },
  });
});
