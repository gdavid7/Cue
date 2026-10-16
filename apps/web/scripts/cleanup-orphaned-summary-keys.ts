// Deletes the AI summary cache's old entries. They were keyed by the whole
// email text and never expired; summaries are now keyed by a hash and expire
// after a week, so these are never read again.
//
// A key is an old summary when all of these hold:
// - its name is not namespaced like the app's keys (`prefix:...`) and is
//   either long (over 200 characters) or contains whitespace, as email text
//   does;
// - it holds a string;
// - it has no expiry.
// The report prints only counts, sizes and hashes of key names, never the
// email text that forms them.
//
// Dry run (default): `pnpm --filter inbox-zero-ai exec tsx scripts/cleanup-orphaned-summary-keys.ts`
// Delete:            `pnpm --filter inbox-zero-ai exec tsx scripts/cleanup-orphaned-summary-keys.ts --apply`

import "dotenv/config";
import { createHash } from "node:crypto";
import { redis } from "@/utils/redis";

const SCAN_COUNT = 1000;
const DELETE_BATCH = 100;
const SAMPLE_COUNT = 5;
const NAMESPACED_KEY = /^[A-Za-z0-9_.@+-]+:\S/;

type Client = {
  scan(
    cursor: string,
    options: { count: number },
  ): Promise<[string | number, string[]]>;
  type(key: string): Promise<string>;
  ttl(key: string): Promise<number>;
  strlen(key: string): Promise<number>;
  unlink(...keys: string[]): Promise<number>;
};

export function looksLikeRawSummaryKey(key: string) {
  if (NAMESPACED_KEY.test(key)) return false;
  return key.length > 200 || /\s/.test(key);
}

export async function findOrphanedSummaryKeys(
  client: Client,
  {
    apply = false,
    log = console.log,
  }: { apply?: boolean; log?: (...args: unknown[]) => void } = {},
) {
  let cursor = "0";
  let scanned = 0;
  let candidates = 0;
  const orphaned: { key: string; bytes: number }[] = [];
  do {
    const [next, keys] = await client.scan(cursor, { count: SCAN_COUNT });
    cursor = String(next);
    scanned += keys.length;
    for (const key of keys) {
      if (!looksLikeRawSummaryKey(key)) continue;
      candidates += 1;
      if ((await client.type(key)) !== "string") continue;
      if ((await client.ttl(key)) !== -1) continue;
      orphaned.push({
        key,
        bytes: Buffer.byteLength(key) + (await client.strlen(key)),
      });
    }
  } while (cursor !== "0");

  log("Scanned keys:", scanned);
  log("Text-like key names:", candidates);
  log("Old summary entries (string, no expiry):", orphaned.length);
  log(
    "Approximate bytes they hold:",
    orphaned.reduce((sum, entry) => sum + entry.bytes, 0),
  );
  log(
    "Samples (key length, key sha256 prefix):",
    orphaned.slice(0, SAMPLE_COUNT).map(({ key }) => ({
      keyLength: key.length,
      keyHash: createHash("sha256").update(key).digest("hex").slice(0, 12),
    })),
  );

  let deleted = 0;
  if (apply) {
    for (let i = 0; i < orphaned.length; i += DELETE_BATCH) {
      const batch = orphaned.slice(i, i + DELETE_BATCH).map(({ key }) => key);
      deleted += await client.unlink(...batch);
    }
    log("Deleted:", deleted);
  } else {
    log("Dry run: nothing deleted. Pass --apply to delete.");
  }
  return { scanned, candidates, orphaned: orphaned.length, deleted };
}

if (process.argv[1] === import.meta.filename) {
  findOrphanedSummaryKeys(redis as unknown as Client, {
    apply: process.argv.includes("--apply"),
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
