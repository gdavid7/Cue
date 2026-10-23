import { NextResponse } from "next/server";
import { getAwaySummary } from "@/utils/home/away-summary";
import { withAuth } from "@/utils/middleware";

export type GetAwaySummaryResponse = Awaited<ReturnType<typeof getAwaySummary>>;

// More than anyone keeps in All inboxes.
const MAX_ACCOUNTS = 20;

/**
 * Today's "While you were away": its own small request beside Today's, so
 * it never holds up the lanes. `accounts` is the comma-separated accounts
 * Today shows. It only reads: the browser records visits (VisitRecorder), and
 * Today's card asks once that has.
 */
export const GET = withAuth("user/home/away", async (request) => {
  const { userId } = request.auth;
  const emailAccountIds = (request.nextUrl.searchParams.get("accounts") ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, MAX_ACCOUNTS);
  const summary = await getAwaySummary({ userId, emailAccountIds });
  // Counts only, and the user's own: never kept in between.
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "private, no-store" },
  });
});
