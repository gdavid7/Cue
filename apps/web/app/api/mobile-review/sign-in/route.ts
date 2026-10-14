import { z } from "zod";
import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { createMobileReviewSession } from "@/utils/mobile-review";
import {
  checkRateLimit,
  createRateLimitKey,
  getClientIp,
  hashRateLimitValue,
} from "@/utils/rate-limit";

const signInSchema = z.object({
  code: z.string().trim().min(1).max(128),
  email: z.string().trim().email(),
});

// Review codes are static secrets, so cap guesses per client and per address.
const SIGN_IN_RATE_LIMITS = {
  ipHourly: { limit: 10, windowSeconds: 60 * 60 },
  emailDaily: { limit: 20, windowSeconds: 24 * 60 * 60 },
};

export const POST = withError("mobile-review/sign-in", async (request) => {
  const body = signInSchema.parse(await request.json());

  await enforceSignInRateLimit({
    clientIp: getClientIp(request.headers),
    email: body.email.toLowerCase(),
    logger: request.logger,
  });

  const result = await createMobileReviewSession({
    code: body.code,
    email: body.email,
    logger: request.logger,
  });

  request.logger.info("Created mobile review session", {
    reviewUserEmail: result.userEmail,
    reviewUserId: result.userId,
    reviewEmailAccountId: result.emailAccountId,
  });

  const response = NextResponse.json({ success: true });
  response.cookies.set(result.sessionCookie.name, result.sessionCookie.value, {
    ...result.sessionCookie.options,
  });
  response.headers.set("Cache-Control", "no-store");

  return response;
});

async function enforceSignInRateLimit({
  clientIp,
  email,
  logger,
}: {
  clientIp: string;
  email: string;
  logger: Logger;
}) {
  const rules = [
    {
      ...SIGN_IN_RATE_LIMITS.ipHourly,
      key: createRateLimitKey([
        "rate-limit",
        "mobile-review-sign-in",
        "ip",
        hashRateLimitValue(clientIp),
      ]),
    },
    {
      ...SIGN_IN_RATE_LIMITS.emailDaily,
      key: createRateLimitKey([
        "rate-limit",
        "mobile-review-sign-in",
        "email",
        hashRateLimitValue(email),
      ]),
    },
  ];
  for (const rule of rules) {
    const result = await checkRateLimit({ rule, logger });
    if (result.limited) {
      throw new SafeError("Too many sign-in attempts. Try again later.", 429);
    }
  }
}
