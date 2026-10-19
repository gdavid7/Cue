import { NextResponse } from "next/server";
import { z } from "zod";
import { isExaSearchEnabled } from "@/utils/exa/search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { CONTEXT_TEXT_LIMIT } from "@/utils/thread-context/get-thread-context";
import {
  getSuggestedReplySettings,
  suggestReply,
} from "@/utils/thread-context/suggest-reply";

const suggestedReplyQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
  web: z.literal("1").nullish(),
  /**
   * The public query the plain pass's abstention asked for, kept by the
   * browser so the web pass needn't write the plain answer again.
   */
  webQuery: z.string().trim().min(1).max(300).nullish(),
});

const label = z.string().max(200);
const days = z.number().int().min(-3650).max(3650);
const contextItem = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum([
    "email",
    "event",
    "file",
    "assignment",
    "chat",
    "web",
    "task",
    "contact",
  ]),
  title: z.string().max(500),
  snippet: z.string().max(500),
  at: z.string().max(64),
  url: z.string().max(2048).optional(),
  source: z.string().max(100).optional(),
  linkedFrom: z.string().max(512).optional(),
  reasons: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("person"), label }),
        z.object({ type: z.literal("organization"), label }),
        z.object({ type: z.literal("via"), label }),
        z.object({ type: z.literal("linked") }),
        z.object({
          type: z.literal("topic"),
          terms: z.array(label).max(20),
        }),
        z.object({ type: z.literal("upcoming"), days }),
        z.object({ type: z.literal("due"), days }),
      ]),
    )
    .max(10),
  text: z.string().max(CONTEXT_TEXT_LIMIT),
});
const suggestedReplyBody = z.object({
  /**
   * The context the reader already gathered for this thread, so it isn't
   * gathered again (related mail, events, and linked pages read through Exa).
   */
  context: z.array(contextItem).max(8).optional(),
});

export type SuggestedReplyBody = z.infer<typeof suggestedReplyBody>;

export type GetSuggestedReplyResponse = {
  suggestion: Awaited<ReturnType<typeof suggestReply>>;
  /** Whether an abstention can be retried with a web search. */
  canSearchWeb: boolean;
};

export const maxDuration = 300;

// A read, not a mutation: POST only because the reader's context is too big
// for a query string.
export const POST = withEmailProvider(
  "user/suggested-reply",
  async (request) => {
    const { searchParams } = new URL(request.url);
    const { context } = suggestedReplyBody.parse(
      await request.json().catch(() => ({})),
    );
    const { threadId, web, webQuery } = suggestedReplyQuery.parse({
      threadId: searchParams.get("threadId"),
      web: searchParams.get("web"),
      webQuery: searchParams.get("webQuery"),
    });

    // Only the web pass is limited: it calls a model and a web search for
    // every thread mail and calendar couldn't answer.
    if (web === "1") {
      await assertWithinUserRateLimit({
        scope: "suggested-reply-web",
        userId: request.auth.userId,
        limit: 40,
        windowSeconds: 5 * 60,
        logger: request.logger,
      });
    }

    const settings = await getSuggestedReplySettings(
      request.auth.emailAccountId,
    );
    // Every request works a suggestion out: the browser keeps the ones it
    // was given, and the server keeps none (RD-3).
    const suggestion = await suggestReply({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      threadId,
      emailProvider: request.emailProvider,
      logger: request.logger,
      searchWeb: web === "1",
      webQuery: webQuery ?? undefined,
      context,
      settings,
    });
    return NextResponse.json({
      suggestion,
      canSearchWeb: isExaSearchEnabled() && settings.webLookupEnabled,
    } satisfies GetSuggestedReplyResponse);
  },
);
