import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { rewriteHtmlForImageProxy } from "@/utils/email/image-proxy.server";
import { renderHtmlBody } from "@/utils/actions/render-html.validation";
import { checkRateLimit, createRateLimitKey } from "@/utils/rate-limit";

export const maxDuration = 30;

// Each response mints signed image-proxy URLs for arbitrary remote images, so
// cap how many a single user can mint well above normal reading and composing.
const RENDER_RATE_LIMIT = { limit: 300, windowSeconds: 5 * 60 };

export const POST = withAuth("email/render-html", async (request) => {
  const rateLimit = await checkRateLimit({
    rule: {
      ...RENDER_RATE_LIMIT,
      key: createRateLimitKey([
        "rate-limit",
        "email-render-html",
        request.auth.userId,
      ]),
    },
    logger: request.logger,
  });
  if (rateLimit.limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again in a little while." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const body = renderHtmlBody.parse(await request.json());

  const result = await rewriteHtmlForImageProxy(body.html, request.logger);

  return NextResponse.json(result);
});
