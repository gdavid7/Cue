import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { assistantStateResultSchema } from "@inboxzero/mail-core/protocol/mail-http";
import {
  accountMismatchResponse,
  mailRequestId,
  MAIL_PROTOCOL_VERSION,
} from "@/utils/mail-api/authorization";
import { readAssistantStatePage } from "@/utils/mail-api/assistant-state";

// Reads only Cue's own records, so it skips the mailbox connection and keeps
// answering while the provider is rate limiting the account.
export const GET = withEmailAccount(
  "mail/v1/assistant-state",
  async (request, context) => {
    const params = await context.params;
    const requestId = mailRequestId(request);
    const mismatch = accountMismatchResponse(
      request,
      params.accountId,
      requestId,
    );
    if (mismatch) return mismatch;
    const page = await readAssistantStatePage({
      emailAccountId: request.auth.emailAccountId,
      cursor: request.nextUrl.searchParams.get("cursor") || null,
    });
    return NextResponse.json(
      assistantStateResultSchema.parse({
        protocolVersion: MAIL_PROTOCOL_VERSION,
        requestId,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        reset: page.reset,
        entries: page.entries,
      }),
    );
  },
);
