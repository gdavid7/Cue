import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getEmailAccount } from "@/utils/redis/account-validation";
import { getSharedSubscriber } from "@/utils/redis/shared-subscriber";
import {
  TRACKER_HINT_MESSAGE,
  localMailHintChannel,
} from "@/utils/redis/local-mail-hints";

export const maxDuration = 300;

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

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let subscription: { close: () => void } | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        request.signal.removeEventListener("abort", close);
        subscription?.close();
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
      request.signal.addEventListener("abort", close);
      lifetime = setTimeout(close, 270_000);
      if (request.signal.aborted) {
        close();
        return;
      }
      // Hints come over the instance's shared connection. Until it is
      // subscribed the tab polls; if the connection drops the stream ends,
      // and the tab reconnects and catches up.
      const listening = getSharedSubscriber().listen(
        localMailHintChannel(emailAccountId),
        {
          onMessage: (message) =>
            send(
              message === TRACKER_HINT_MESSAGE
                ? "trackers-change"
                : "mailbox-change",
            ),
          onLost: close,
        },
      );
      subscription = listening;
      listening.ready
        .then(() => {
          if (closed) return;
          send("ready");
          // Keeps proxies from timing the idle stream out; costs no Redis.
          heartbeat = setInterval(() => send("heartbeat"), 25_000);
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
