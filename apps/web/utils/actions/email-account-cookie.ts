"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import prisma from "@/utils/prisma";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  type LastEmailAccountCookieValue,
} from "@/utils/cookies";
import { clearLastEmailAccountCookie } from "@/utils/cookies.server";
import {
  actionClientUser,
  publicActionClient,
} from "@/utils/actions/safe-action";

/**
 * Sets a cookie with the last selected email account ID.
 * This is used when emailAccountId is not provided in the URL.
 */
export const setLastEmailAccountAction = actionClientUser
  .metadata({ name: "setLastEmailAccount" })
  .inputSchema(z.object({ emailAccountId: z.string() }))
  .action(async ({ ctx: { userId }, parsedInput: { emailAccountId } }) => {
    const emailAccount = await prisma.emailAccount.findFirst({
      where: { id: emailAccountId, userId },
      select: { id: true },
    });
    if (!emailAccount) return;

    const cookieStore = await cookies();

    const cookieValue: LastEmailAccountCookieValue = {
      userId,
      emailAccountId: emailAccount.id,
    };
    const value = JSON.stringify(cookieValue);

    cookieStore.set(LAST_EMAIL_ACCOUNT_COOKIE, value, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year
      sameSite: "lax",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
  });

/**
 * Clears the last email account cookie.
 * Called on logout to prevent stale account IDs when switching users.
 * Needs no session: it only deletes the caller's own cookie, and sign-out may
 * already have ended the session (or it expired) by the time it runs. It
 * reads nothing and calls nothing, so there is nothing to rate-limit.
 */
export const clearLastEmailAccountAction = publicActionClient
  .metadata({ name: "clearLastEmailAccount" })
  .action(async () => {
    await clearLastEmailAccountCookie();
  });
