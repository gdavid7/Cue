import { NextResponse } from "next/server";
import { composeAssistBody } from "@/app/api/ai/compose-assist/validation";
import {
  aiComposeAssist,
  getComposeAssistContext,
} from "@/utils/ai/compose/compose-assist";
import { withEmailAccount } from "@/utils/middleware";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { checkRateLimit, createRateLimitKey } from "@/utils/rate-limit";
import { getEmailAccountWithAi } from "@/utils/user/get";

export const maxDuration = 120;

// Each request is a model call. Well above a person rewriting and retrying
// by hand, well below a script.
const COMPOSE_ASSIST_RATE_LIMIT = { limit: 60, windowSeconds: 5 * 60 };

export const POST = withEmailAccount("ai/compose-assist", async (request) => {
  const { emailAccountId } = request.auth;
  const rateLimit = await checkRateLimit({
    rule: {
      ...COMPOSE_ASSIST_RATE_LIMIT,
      key: createRateLimitKey(["rate-limit", "compose-assist", emailAccountId]),
    },
    logger: request.logger,
  });
  if (rateLimit.limited) {
    return NextResponse.json(
      {
        error: "Cue needs a short break. Try again in a few minutes.",
        isKnownError: true,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }
  const parsed = composeAssistBody.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid request",
        isKnownError: true,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) {
    return NextResponse.json(
      { error: "Email account not found" },
      { status: 404 },
    );
  }
  await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  });

  const context = await getComposeAssistContext({
    emailAccount,
    threadId: body.threadId,
    to: body.to,
    draftText: `${body.before}${body.text}${body.after}`,
    logger: request.logger,
  });
  const result = await aiComposeAssist({
    emailAccount,
    request: body,
    context,
    abortSignal: request.signal,
  });
  return result.toTextStreamResponse();
});
