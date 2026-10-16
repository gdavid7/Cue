import { env } from "@/env";
import { Redis } from "@upstash/redis";
import { getRedisUsageMeter } from "@/utils/redis/usage-meter";

// Counted per instance and logged as "Redis usage" from request flushes.
export const redis = getRedisUsageMeter().wrap(
  new Redis({
    url: env.REDIS_HTTP_URL,
    token: env.REDIS_HTTP_TOKEN,
  }),
);
