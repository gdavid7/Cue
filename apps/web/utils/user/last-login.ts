import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

// The admin views and Today's "While you were away" read it, and the app
// layout, which every navigation and prefetch renders, writes at most hourly.
const LAST_LOGIN_PRECISION_MS = 60 * 60_000;
// A return after this long is a new visit: Today then sums up what Cue did
// since the last one. A working day's hourly writes never leave a gap this big.
export const AWAY_GAP_MS = 4 * 60 * 60_000;

/**
 * Records that the user is using the app, at most once an hour. Back after a
 * break, the last login moves to previousVisitAt first. One conditional
 * statement, so the layout and Today racing on the same visit move it once.
 */
export async function recordLastLogin(userId: string, now = new Date()) {
  const precisionCutoff = new Date(now.getTime() - LAST_LOGIN_PRECISION_MS);
  const awayCutoff = new Date(now.getTime() - AWAY_GAP_MS);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "User" SET
      "previousVisitAt" = CASE
        WHEN "lastLogin" < ${awayCutoff} THEN "lastLogin"
        ELSE "previousVisitAt"
      END,
      "lastLogin" = ${now}
    WHERE id = ${userId}
      AND ("lastLogin" IS NULL OR "lastLogin" < ${precisionCutoff})
  `);
}
