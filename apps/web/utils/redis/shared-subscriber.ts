import type Redis from "ioredis";
import { createScopedLogger } from "@/utils/logger";
import { RedisSubscriber } from "@/utils/redis/subscriber";
import { logRedisFailureOnce } from "@/utils/redis/unavailable-log";

const logger = createScopedLogger("redis/shared-subscriber");

type Listener = {
  onMessage: (message: string) => void;
  /** The connection dropped after this listener's subscription was live. */
  onLost: () => void;
};

type Channel = {
  listeners: Set<Listener>;
  live: Set<Listener>;
  subscribed: Promise<unknown>;
};

declare global {
  var sharedRedisSubscriber:
    | ReturnType<typeof createSharedSubscriber>
    | undefined;
}

/**
 * The instance's one pub/sub connection. Streams (a tab per account, a
 * shared conversation) listen here rather than opening their own, so a
 * connection, its handshake and each SUBSCRIBE are paid once per instance.
 */
export function getSharedSubscriber() {
  global.sharedRedisSubscriber ??= createSharedSubscriber(() =>
    RedisSubscriber.createInstance(),
  );
  return global.sharedRedisSubscriber;
}

export function createSharedSubscriber(createClient: () => Redis) {
  let client: Redis | null = null;
  const channels = new Map<string, Channel>();

  const connect = () => {
    if (client) return client;
    const created = createClient();
    created.on("message", (channel: string, message: string) => {
      for (const listener of channels.get(channel)?.listeners ?? [])
        listener.onMessage(message);
    });
    // ioredis reconnects and resubscribes on its own; what was published
    // meanwhile is lost, so live listeners hear about it.
    created.on("close", () => {
      for (const channel of channels.values()) {
        for (const listener of channel.live) listener.onLost();
        channel.live.clear();
      }
    });
    created.on("error", (error: unknown) => {
      logRedisFailureOnce(logger, "Shared Redis subscriber error", { error });
    });
    client = created;
    return created;
  };

  return {
    listen(channelName: string, listener: Listener) {
      const redis = connect();
      let channel = channels.get(channelName);
      if (!channel) {
        const created: Channel = {
          listeners: new Set(),
          live: new Set(),
          subscribed: redis.subscribe(channelName),
        };
        created.subscribed.catch(() => {
          if (channels.get(channelName) === created)
            channels.delete(channelName);
        });
        channels.set(channelName, created);
        channel = created;
      }
      const joined = channel;
      joined.listeners.add(listener);
      let closed = false;
      return {
        ready: joined.subscribed.then(() => {
          if (!closed) joined.live.add(listener);
        }),
        close() {
          if (closed) return;
          closed = true;
          joined.listeners.delete(listener);
          joined.live.delete(listener);
          if (joined.listeners.size > 0 || channels.get(channelName) !== joined)
            return;
          channels.delete(channelName);
          redis.unsubscribe(channelName).catch(() => undefined);
        },
      };
    },
  };
}
