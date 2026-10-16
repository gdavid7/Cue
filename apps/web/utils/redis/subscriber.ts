import Redis from "ioredis";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { logRedisFailureOnce } from "@/utils/redis/unavailable-log";

const logger = createScopedLogger("ioredis");

// biome-ignore lint/complexity/noStaticOnlyClass: ignore
class RedisSubscriber {
  static createInstance(): Redis {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is not set");
    }

    logger.trace("Initializing Redis subscriber connection");
    const redisSubscriber = new Redis(env.REDIS_URL);

    // ioredis reports every failed reconnect attempt; an outage would log
    // one line per attempt per instance.
    redisSubscriber.on("error", (error) => {
      logRedisFailureOnce(logger, "Redis connection error", { error });
    });

    redisSubscriber.on("connect", () => {
      logger.trace("Redis connected successfully");
    });

    return redisSubscriber;
  }
}

export { RedisSubscriber };
