import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_CACHE_WRITES } from "./server-cache-allowlist";

/**
 * RD-3: no email content or personal data in Redis or any other server-side
 * cache. Every file that writes to one is recorded in server-cache-allowlist.ts
 * with what each of its keys holds, and with how many write sites it has, so
 * a new write (or a new cache) fails here until someone records what it keeps.
 */
const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "generated",
  "__tests__",
  "__mocks__",
  "scripts",
  "public",
  ".turbo",
  "coverage",
]);

// A file that reaches a Redis client or a server cache primitive.
const CACHE_PRIMITIVE =
  /from\s+["'](?:@\/utils\/redis|@upstash\/redis|ioredis|resumable-stream(?:\/[\w-]+)?|@chat-adapter\/state-ioredis|bullmq)["']|\bcreateMemoCache\(|\bunstable_cache\(|["']use cache["']/;

const WRITE_COMMANDS = [
  "set",
  "setex",
  "psetex",
  "setnx",
  "mset",
  "msetnx",
  "getset",
  "hset",
  "hsetnx",
  "hmset",
  "hincrby",
  "hincrbyfloat",
  "incr",
  "incrby",
  "incrbyfloat",
  "decr",
  "decrby",
  "expire",
  "pexpire",
  "persist",
  "append",
  "lpush",
  "rpush",
  "lset",
  "linsert",
  "sadd",
  "zadd",
  "zincrby",
  "xadd",
  "publish",
  "eval",
  "evalsha",
  "appendToList",
  "rename",
  "copy",
].join("|");
const RECEIVER = String.raw`\b(?:redis|pipeline|publisher|client|connection|multi|tx|getPublisher\([^()]*\))`;
// A chained call between the receiver and the write, such as `.multi()`.
const CHAIN = String.raw`(?:\s*\.\s*\w+\((?:[^()]|\([^()]*\))*\))*`;
const WRITE_SITE = new RegExp(
  [
    String.raw`${RECEIVER}${CHAIN}\s*\.\s*(?:${WRITE_COMMANDS})\s*[<(]`,
    String.raw`\bcreateMemoCache\s*[<(]`,
    String.raw`\bunstable_cache\s*\(`,
    `["']use cache["']`,
    String.raw`\bnew\s+(?:Redis|IORedis)\s*\(`,
    String.raw`\bcreateResumableStreamContext\s*\(`,
    String.raw`\bcreateIoRedisState\s*\(`,
  ].join("|"),
  "g",
);

describe("server cache writes", () => {
  const found = findCacheWriteSites();

  it("are each recorded with what their keys hold", () => {
    expect(
      Object.fromEntries(found.map(({ file, writes }) => [file, writes])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(SERVER_CACHE_WRITES).map(([file, entry]) => [
          file,
          entry.writes,
        ]),
      ),
    );
  });

  it.each(
    Object.entries(SERVER_CACHE_WRITES),
  )("%s documents every key it keeps", (_file, entry) => {
    expect(entry.keys.length).toBeGreaterThan(0);
    for (const key of entry.keys) {
      expect(key.key.trim()).not.toBe("");
      expect(key.holds.trim()).not.toBe("");
      expect(key.ttl.trim()).not.toBe("");
    }
  });
});

describe("write site detection", () => {
  it("finds writes however they are formatted", () => {
    expect(
      countWrites(`
        await redis
          .set(key, value, { ex: 60 });
        const pipeline = redis.pipeline();
        pipeline.set(key, thread);
        await redis.multi().hincrby(key, "f", 1).expire(key, 10).exec();
        await getPublisher(env.REDIS_URL).publish(channel, "{}");
        await redis.eval<string[], number>(script, [key], []);
        const memo = createMemoCache<string>({ ttlMs: 1, maxEntries: 1 });
      `),
    ).toBe(6);
  });

  it("leaves in-memory maps and reads alone", () => {
    expect(
      countWrites(`
        const seen = new Map();
        seen.set(key, value);
        await redis.get(key);
        await redis.mget(...keys);
        // redis.set(key, value) in a comment
      `),
    ).toBe(0);
  });
});

function findCacheWriteSites() {
  return listFiles(WEB_ROOT)
    .flatMap((file) => {
      const source = withoutComments(readFileSync(file, "utf8"));
      if (!CACHE_PRIMITIVE.test(source)) return [];
      return [{ file: relative(file), writes: countWrites(source) }];
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function countWrites(source: string) {
  return [...withoutComments(source).matchAll(WRITE_SITE)].length;
}

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return SKIP_DIRS.has(name) ? [] : listFiles(full);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)
      ? [full]
      : [];
  });
}

function relative(file: string) {
  return path.relative(WEB_ROOT, file).split(path.sep).join("/");
}
