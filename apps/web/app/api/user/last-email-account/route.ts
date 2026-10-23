import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/utils/prisma";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  type LastEmailAccountCookieValue,
} from "@/utils/cookies";
import { withAuth } from "@/utils/middleware";

const bodySchema = z.object({ emailAccountId: z.string().min(1) });

// A route handler, not a server action: an action that sets a cookie makes
// Next.js re-render the open route, which hard-reloads a page the user has
// already navigated away from.
export const POST = withAuth("user/last-email-account", async (request) => {
  const { userId } = request.auth;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const emailAccount = await prisma.emailAccount.findFirst({
    where: { id: parsed.data.emailAccountId, userId },
    select: { id: true },
  });
  if (!emailAccount) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const cookieValue: LastEmailAccountCookieValue = {
    userId,
    emailAccountId: emailAccount.id,
  };
  const response = NextResponse.json({ ok: true });
  response.cookies.set(LAST_EMAIL_ACCOUNT_COOKIE, JSON.stringify(cookieValue), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
});
