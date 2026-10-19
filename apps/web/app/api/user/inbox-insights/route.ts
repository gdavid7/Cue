import { NextResponse } from "next/server";
import { z } from "zod";
import {
  OPEN_THREAD_GMAIL_WAIT_MS,
  runWithGmailWaitBudget,
} from "@/utils/gmail/quota";
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

const knownQuery = z.array(z.string().min(1).max(512)).max(MAX_ITEMS);

export type GetInboxInsightsResponse = Awaited<
  ReturnType<typeof getInboxInsights>
>;

export const maxDuration = 300;

/**
 * `?items=threadId:messageId,...` — each thread with its latest message.
 * `known=messageId,...` names the messages the browser already holds an
 * insight for; `events=1` asks for upcoming meetings to match its people.
 * `open=1` asks for the one conversation on screen, which someone is looking
 * at, so its reads run at interactive priority (D-086) and answer or defer
 * within the open thread's wait budget; the rows' stay background.
 */
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

  const searchParams = new URL(request.url).searchParams;
  const known = knownQuery.parse(
    (searchParams.get("known") ?? "").split(",").filter(Boolean),
  );

  const load = () =>
    getInboxInsights({
      emailAccountId: request.auth.emailAccountId,
      userId: request.auth.userId,
      userEmail: request.auth.email,
      items,
      known,
      withEvents: searchParams.get("events") === "1",
      emailProvider: request.emailProvider,
      logger: request.logger,
    });
  const result =
    searchParams.get("open") === "1" && items.length === 1
      ? await runWithGmailWaitBudget(OPEN_THREAD_GMAIL_WAIT_MS, load, {
          priority: "interactive",
        })
      : await load();
  return NextResponse.json(result satisfies GetInboxInsightsResponse);
});
