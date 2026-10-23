import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

// The admin views and Today's "While you were away" read it. The app shell's
// VisitRecorder writes it from the browser while the user is using the app
// (on load, on input and when the tab comes back), since the layout doesn't
// render again on client navigation. Within this, a write changes nothing.
const LAST_LOGIN_PRECISION_MS = 10 * 60_000;
// A return after this long is a new visit: Today then sums up what Cue did
// since the last one. Using the app never leaves a gap this big.
export const AWAY_GAP_MS = 4 * 60 * 60_000;

/**
 * Records that the user is using the app. Back after a break, the last login
 * moves to previousVisitAt and the return time to visitReturnedAt first. One
 * conditional statement, so two tabs recording the same return move it once.
 * Returns whether this call was that return.
 */
export async function recordLastLogin(
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const precisionCutoff = new Date(now.getTime() - LAST_LOGIN_PRECISION_MS);
  const awayCutoff = new Date(now.getTime() - AWAY_GAP_MS);
  const rows = await prisma.$queryRaw<{ returned: boolean }[]>(Prisma.sql`
    UPDATE "User" SET
      "previousVisitAt" = CASE
        WHEN "lastLogin" < ${awayCutoff} THEN "lastLogin"
        ELSE "previousVisitAt"
      END,
      "visitReturnedAt" = CASE
        WHEN "lastLogin" < ${awayCutoff} THEN ${now}
        ELSE "visitReturnedAt"
      END,
      "lastLogin" = ${now}
    WHERE id = ${userId}
      AND ("lastLogin" IS NULL OR "lastLogin" < ${precisionCutoff})
    RETURNING "visitReturnedAt" IS NOT DISTINCT FROM ${now} AS returned
  `);
  return rows[0]?.returned ?? false;
}
