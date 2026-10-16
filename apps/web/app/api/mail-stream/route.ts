import { NextResponse } from "next/server";
import { env } from "@/env";
import { withAuth } from "@/utils/middleware";
import { getEmailAccount } from "@/utils/redis/account-validation";
import { RedisSubscriber } from "@/utils/redis/subscriber";
import {
  TRACKER_HINT_MESSAGE,
  localMailHintChannel,
  refreshLocalMailInterest,
} from "@/utils/redis/local-mail-hints";

export const maxDuration = 300;

let warnedRedisMissing = false;

export const GET = withAuth("mail-stream", async (request) => {
  const emailAccountId = new URL(request.url).searchParams.get(
    "emailAccountId",
  );
  if (!emailAccountId)
    return NextResponse.json(
      { error: "Email account ID is required" },
      { status: 400 },
    );
  if (
    !(await getEmailAccount({ userId: request.auth.userId, emailAccountId }))
  ) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 403 });
  }

  // Hints travel over Redis. Without it there is nothing to stream, and
  // clients poll for changes while the stream is down. A 204 tells
  // EventSource to stop reconnecting rather than fail as a server error.
  if (!env.REDIS_URL) {
    if (!warnedRedisMissing) {
      warnedRedisMissing = true;
      request.logger.warn(
        "Mail stream disabled: REDIS_URL is not set, so clients poll for changes",
      );
    }
    return new Response(null, { status: 204 });
  }

  const subscriber = RedisSubscriber.createInstance();
  const channel = localMailHintChannel(emailAccountId);
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let refreshing = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        request.signal.removeEventListener("abort", close);
        subscriber.off("message", onMessage);
        subscriber.off("error", close);
        subscriber.disconnect();
        try {
          controller.close();
        } catch {
          /* The reader may already be cancelled. */
        }
      };
      cleanup = close;
      const send = (event: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`));
        } catch {
          close();
        }
      };
      const onMessage = (receivedChannel: string, message: string) => {
        if (receivedChannel !== channel) return;
        send(
          message === TRACKER_HINT_MESSAGE
            ? "trackers-change"
            : "mailbox-change",
        );
      };
      const refresh = async () => {
        if (closed || refreshing) return;
        refreshing = true;
        try {
          await refreshLocalMailInterest(emailAccountId);
          send("heartbeat");
        } catch {
          close();
        } finally {
          refreshing = false;
        }
      };
      request.signal.addEventListener("abort", close);
      subscriber.on("message", onMessage);
      subscriber.on("error", close);
      lifetime = setTimeout(close, 270_000);
      if (request.signal.aborted) {
        close();
        return;
      }
      subscriber
        .subscribe(channel)
        .then(async () => {
          if (closed) return;
          await refresh();
          if (closed) return;
          send("ready");
          heartbeat = setInterval(() => {
            refresh();
          }, 25_000);
        })
        .catch(close);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
