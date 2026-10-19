import prisma from "@/utils/prisma";

// Only the admin views read it, so an hour is precise enough, and the app
// layout, which every navigation and prefetch renders, writes at most hourly.
const LAST_LOGIN_PRECISION_MS = 60 * 60_000;

/** Records that the user is using the app, at most once an hour. */
export async function recordLastLogin(email: string, now = new Date()) {
  await prisma.user.updateMany({
    where: {
      email,
      OR: [
        { lastLogin: null },
        {
          lastLogin: {
            lt: new Date(now.getTime() - LAST_LOGIN_PRECISION_MS),
          },
        },
      ],
    },
    data: { lastLogin: now },
  });
}
