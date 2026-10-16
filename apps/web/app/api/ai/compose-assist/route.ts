import { NextResponse } from "next/server";
import { composeAssistBody } from "@/app/api/ai/compose-assist/validation";
import {
  aiComposeAssist,
  getComposeAssistContext,
} from "@/utils/ai/compose/compose-assist";
import { withEmailAccount } from "@/utils/middleware";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { getEmailAccountWithAi } from "@/utils/user/get";

export const maxDuration = 120;

export const POST = withEmailAccount("ai/compose-assist", async (request) => {
  const { emailAccountId, userId } = request.auth;
  // Each request is a model call. Well above a person rewriting and retrying
  // by hand, well below a script, across all of the person's accounts.
  await assertWithinUserRateLimit({
    scope: "compose-assist",
    userId,
    limit: 60,
    windowSeconds: 5 * 60,
    logger: request.logger,
  });
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
