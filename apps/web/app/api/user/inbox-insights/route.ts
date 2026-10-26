import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createGmailQuotaStats,
  OPEN_THREAD_GMAIL_WAIT_MS,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import {
  getInboxInsights,
  selectNewInsightItems,
} from "@/utils/inbox-insights/get-inbox-insights";
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

// What the rows' reads wait at the gate in all before the rest is deferred
// to the browser's next request (PF-9v). Waits are summed across the
// request's concurrent reads, so the request answers within a few seconds
// of queueing rather than holding a lambda for most of a minute.
const BACKGROUND_GMAIL_WAIT_MS = 10_000;

/**
 * `?items=threadId:messageId,...` — each thread with its latest message.
 * `known=messageId,...` names the messages the browser already holds an
 * insight for; `events=1` asks for upcoming meetings to match its people.
 * `open=1` asks for the one conversation on screen, which someone is looking
 * at, so its reads run at interactive priority (D-086) and answer or defer
 * within the open thread's wait budget; the rows' stay background, with a
 * budget of their own: what is ready goes back and `deferred` names the rest.
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

  const isOpenThread = searchParams.get("open") === "1" && items.length === 1;
  // Numbers and a lane only, so "Request completed" can set a chunk's size
  // against its duration.
  request.logger = request.logger.with({
    itemCount: items.length,
    newCount: selectNewInsightItems(items, known).length,
    priority: isOpenThread ? "interactive" : "background",
  });

  const load = () =>
    getInboxInsights({
      emailAccountId: request.auth.emailAccountId,
      userId: request.auth.userId,
      userEmail: request.auth.email,
      items,
      known,
      withEvents: searchParams.get("events") === "1",
      openThread: isOpenThread,
      emailProvider: request.emailProvider,
      logger: request.logger,
    });
  // `waitMs` on "Request completed" sums the gate's sleeps with the
  // in-flight slot queue's and retry backoff, across reads that wait side by
  // side; the gate's own share is logged apart so the two can be told apart
  // (CP-1d). A deferred request still logs what it waited.
  const gate = createGmailQuotaStats();
  try {
    const result = await runWithGmailQuota(
      {
        priority: isOpenThread ? "interactive" : "background",
        maxTotalWaitMs: isOpenThread
          ? OPEN_THREAD_GMAIL_WAIT_MS
          : BACKGROUND_GMAIL_WAIT_MS,
        stats: gate,
      },
      load,
    );
    request.logger = request.logger.with({
      deferredCount: result.deferred?.messageIds.length ?? 0,
    });
    return NextResponse.json(result satisfies GetInboxInsightsResponse);
  } finally {
    request.logger = request.logger.with({
      gateWaitMs: Math.round(gate.waitMs),
    });
  }
});
