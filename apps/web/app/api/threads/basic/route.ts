import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import type { EmailProvider } from "@/utils/email/types";
import { threadsQuery } from "@/utils/threads/validation";
import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";

// Straight from the provider — this route does no ExecutedRule join, so it
// must not borrow the main threads type, which promises `plan` and `plans`.
export type GetThreadsResponse = {
  threads: Awaited<ReturnType<EmailProvider["getThreadsWithQuery"]>>["threads"];
  nextPageToken?: string;
};

export const maxDuration = 30;

export const GET = withEmailProvider(
  "threads/basic",
  async (request) => {
    const { emailProvider } = request;
    const { emailAccountId } = request.auth;

    const { searchParams } = new URL(request.url);
    const query = threadsQuery
      .pick({
        fromEmail: true,
        labelId: true,
        limit: true,
        nextPageToken: true,
      })
      .parse({
        fromEmail: searchParams.get("fromEmail"),
        labelId: searchParams.get("labelId"),
        limit: searchParams.get("limit"),
        nextPageToken: searchParams.get("nextPageToken"),
      });

    try {
      const { threads, nextPageToken } =
        await emailProvider.getThreadsWithQuery({
          query,
          maxResults: query.limit || 100,
          pageToken: query.nextPageToken || undefined,
        });

      return NextResponse.json({
        threads,
        nextPageToken,
      });
    } catch (error) {
      // The middleware answers these with 503 or 429 and Retry-After.
      if (
        getGmailCallDeferredError(error) ||
        isEmailProviderRateLimitError({ error, provider: emailProvider.name })
      )
        throw error;
      request.logger.error("Error fetching basic threads", {
        error,
        emailAccountId,
      });

      return NextResponse.json(
        { error: "Failed to fetch threads" },
        { status: 500 },
      );
    }
  },
  { maxDuration },
);
