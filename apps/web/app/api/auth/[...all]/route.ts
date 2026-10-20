import { betterAuthConfig } from "@/utils/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { deduplicateOAuthCallback } from "@/utils/oauth/auth-callback-deduplication";
import { runWithCallbackTimings } from "@/utils/oauth/callback-timings";
import { createScopedLogger } from "@/utils/logger";
import { isMcpServerAvailable } from "@/utils/mcp/config";
import { getMcpOAuthRateLimitResponse } from "@/utils/mcp/rate-limit";

const logger = createScopedLogger("auth/oauth-callback");
const handlers = toNextJsHandler(betterAuthConfig);
const CALLBACK_PATH_REGEX = /\/api\/auth\/(?:oauth2\/)?callback\/([^/]+)\/?$/;

export const maxDuration = 300;
export const { PUT, PATCH, DELETE } = handlers;

export const POST: typeof handlers.POST = async (...args) => {
  const [request] = args;
  return withMcpOAuthRateLimit(request, () =>
    withSignInTimings(request, () => handlers.POST(...args)),
  );
};

export const GET: typeof handlers.GET = async (...args) => {
  const [request] = args;

  return withMcpOAuthRateLimit(request, () =>
    withSignInTimings(request, () =>
      deduplicateOAuthCallback({
        request,
        handleRequest: () => handlers.GET(...args),
        logger,
      }),
    ),
  );
};

async function withMcpOAuthRateLimit(
  request: Request,
  handle: () => ReturnType<typeof handlers.POST>,
) {
  if (!isMcpServerAvailable()) return handle();
  const limited = await getMcpOAuthRateLimitResponse({ request, logger });
  if (limited) return limited;
  return handle();
}

function withSignInTimings(
  request: Request,
  handle: () => ReturnType<typeof handlers.POST>,
) {
  const provider = new URL(request.url).pathname.match(
    CALLBACK_PATH_REGEX,
  )?.[1];
  if (!provider) return handle();
  return runWithCallbackTimings({ flow: "sign-in", provider, logger }, handle);
}
