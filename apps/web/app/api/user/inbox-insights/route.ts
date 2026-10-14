import { NextResponse } from "next/server";
import { z } from "zod";
import { getInboxInsights } from "@/utils/inbox-insights/get-inbox-insights";
import { withEmailProvider } from "@/utils/middleware";

// One page of the inbox; the hook splits longer lists into requests this size.
const MAX_ITEMS = 50;

const inboxInsightsQuery = z.object({
  items: z
    .array(
      z.object({
        threadId: z.string().min(1).max(512),
        messageId: z.string().min(1).max(512),
      }),
    )
    .min(1)
    .max(MAX_ITEMS),
});

export type GetInboxInsightsResponse = Awaited<
  ReturnType<typeof getInboxInsights>
>;

export const maxDuration = 300;

/** `?items=threadId:messageId,...` — each thread with its latest message. */
export const GET = withEmailProvider("user/inbox-insights", async (request) => {
  const raw = new URL(request.url).searchParams.get("items") ?? "";
  const { items } = inboxInsightsQuery.parse({
    items: raw
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        // `searchParams` has already decoded each id once.
        const [threadId, messageId] = pair.split(":");
        return { threadId, messageId };
      }),
  });

  const result = await getInboxInsights({
    emailAccountId: request.auth.emailAccountId,
    userEmail: request.auth.email,
    items,
    emailProvider: request.emailProvider,
    logger: request.logger,
  });
  return NextResponse.json(result satisfies GetInboxInsightsResponse);
});
