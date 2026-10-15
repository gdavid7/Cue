import { after, NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import {
  changesBatchRequestSchema,
  changesBatchResultSchema,
  mailHttpErrorResponse,
} from "@inboxzero/mail-core/protocol/mail-http";
import {
  accountMismatchResponse,
  bodyAccountMismatchResponse,
  mailRequestId,
  unsupportedVersionResponse,
} from "@/utils/mail-api/authorization";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";
import { nudgeCatchUpForNewGmail } from "@/utils/mail-api/new-mail-catch-up";
import { isGoogleProvider } from "@/utils/email/provider-types";

export const POST = withEmailProvider(
  "mail/v1/changes-batch",
  async (request, context) => {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) ?? {};
    const requestId = mailRequestId(request, body);
    const mismatch = accountMismatchResponse(
      request,
      params.accountId,
      requestId,
    );
    if (mismatch) return mismatch;
    const version = unsupportedVersionResponse(requestId, body.protocolVersion);
    if (version) return version;
    const parsed = changesBatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        mailHttpErrorResponse({ requestId, code: "invalid", retryable: false }),
        { status: 400 },
      );
    }
    const bodyMismatch = bodyAccountMismatchResponse(
      request.auth.emailAccountId,
      parsed.data,
      requestId,
    );
    if (bodyMismatch) return bodyMismatch;
    const source = createEmailProviderMailboxSource({
      provider: request.emailProvider,
      accountId: request.auth.emailAccountId,
      logger: request.logger,
    });
    const results = await source.readChangesBatch({
      ...parsed.data,
      signal: request.signal,
    });
    if (isGoogleProvider(request.emailProvider.name)) {
      after(() =>
        nudgeCatchUpForNewGmail({
          emailAccountId: request.auth.emailAccountId,
          results,
          logger: request.logger,
        }),
      );
    }
    const { protocolVersion } = parsed.data;
    return NextResponse.json(
      changesBatchResultSchema.parse({
        protocolVersion,
        requestId,
        results: results.map((result, index) => ({
          ...result,
          protocolVersion,
          requestId: parsed.data.reads[index]?.requestId ?? requestId,
        })),
      }),
    );
  },
);
