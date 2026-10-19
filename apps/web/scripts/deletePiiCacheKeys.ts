// One-off RD-3 cleanup: deletes the email content and personal data that
// Redis still holds from before Cue stopped caching it. Idempotent, and uses
// SCAN with UNLINK, never KEYS.
//
// Run from apps/web against the Redis to clean, after the deploy:
//   REDIS_HTTP_URL=... REDIS_HTTP_TOKEN=... pnpm exec tsx scripts/deletePiiCacheKeys.ts --dry-run
//   REDIS_HTTP_URL=... REDIS_HTTP_TOKEN=... pnpm exec tsx scripts/deletePiiCacheKeys.ts
// Add --include-legacy-usage to also delete the lifetime usage counters still
// keyed by address (any not yet migrated to the account's key are lost).
// The Chat SDK lists live on REDIS_URL; if that is another Redis than
// REDIS_HTTP_URL, run this against it too.

import { Redis } from "@upstash/redis";
import { deletePiiCacheKeys } from "./lib/pii-cache-keys";

const url = process.env.REDIS_HTTP_URL;
const token = process.env.REDIS_HTTP_TOKEN;
if (!url || !token) {
  console.error(
    "Set REDIS_HTTP_URL and REDIS_HTTP_TOKEN for the Redis to clean.",
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const redis = new Redis({ url, token });

deletePiiCacheKeys({
  redis: {
    scan: (cursor, options) => redis.scan(cursor, options),
    unlink: (...keys) => redis.unlink(...keys),
    renamenx: (source, destination) => redis.renamenx(source, destination),
  },
  dryRun: args.has("--dry-run"),
  includeLegacyUsage: args.has("--include-legacy-usage"),
  log: (line) => console.log(line),
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
