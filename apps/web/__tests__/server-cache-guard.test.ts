import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEY_TEMPLATE_EXCEPTIONS,
  SERVER_CACHE_WRITES,
} from "./server-cache-allowlist";

/**
 * RD-3: no email content or personal data in Redis or any other server-side
 * cache. Every file that writes to one is recorded in server-cache-allowlist.ts
 * with what each of its keys holds, and with how many write sites it has, so
 * a new write (or a new cache) fails here until someone records what it keeps.
 */
const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
// Shared packages can reach Redis too.
const SCAN_ROOTS = [WEB_ROOT, path.join(REPO_ROOT, "packages")];
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
  "dist",
]);

// A file that reaches a Redis client, a Redis helper module or a server cache
// primitive.
const CACHE_PRIMITIVE =
  /from\s+["'](?:@\/utils\/redis(?:\/[\w-]+)?|@\/utils\/memo-cache|@upstash\/redis|ioredis|resumable-stream(?:\/[\w-]+)?|@chat-adapter\/state-ioredis|bullmq)["']|\bcreateMemoCache\(|\bunstable_cache\(|["']use cache["']/;

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
const RECEIVER = String.raw`\b(?:redis|pipeline|publisher|client|connection|multi|tx|cache|kv|state|store|stateAdapter|getPublisher\([^()]*\))`;
// A chained call between the receiver and the write, such as `.multi()`.
const CHAIN = String.raw`(?:\s*\.\s*\w+\((?:[^()]|\([^()]*\))*\))*`;
const WRITE_SITE = new RegExp(
  [
    String.raw`${RECEIVER}${CHAIN}\s*\.\s*(?:${WRITE_COMMANDS})\s*[<(]`,
    String.raw`\bcreateMemoCache\s*[<(]`,
    // A shared lock helper writes whatever key its caller builds.
    String.raw`(?<!function\s+)\b(?:acquireOwnedLock|markOwnedLockProcessed)\s*\(`,
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

// A Redis-key-shaped template (`prefix:${...}`) that puts an address, a name
// or mail content into the key. Hashed values pass.
const KEY_TEMPLATE = /`([\w-]+:(?:[^`\\]|\\.)*)`/g;
const RISKY_VALUE =
  /(?:^|\.)(?:\w*email|\w*address(?:es)?|\w*name|subject|sender|recipients?|from|to|snippet|body)$/i;

describe("server cache keys", () => {
  it("never interpolate an address, a name or mail content", () => {
    const found = listSources()
      .filter(({ source }) => CACHE_PRIMITIVE.test(source))
      .flatMap(({ file, source }) =>
        riskyKeyTemplates(source).map((template) => `${file}: ${template}`),
      );
    expect(found.sort()).toEqual(Object.keys(KEY_TEMPLATE_EXCEPTIONS).sort());
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

  it("counts other cache receivers and shared lock helpers", () => {
    expect(
      countWrites(`
        await cache.set(key, value);
        await kv.set(key, value);
        await state.set(key, value);
        await acquireOwnedLock({ key: \`lease:\${id}\`, processingTtlSeconds: 5 });
      `),
    ).toBe(4);
  });

  it("flags a key that names an address, but not a hashed one or an id", () => {
    // Built from parts, so this file holds no template placeholder itself.
    const value = (expression: string) => `$${"{"}${expression}}`;
    const key = (...parts: string[]) => `\`${parts.join(":")}\``;
    const named = key("lock", value("userEmail"), value("messageId"));
    const person = key("contact", value("person.name"));
    expect(
      riskyKeyTemplates(
        [
          named,
          key(
            "lock",
            value("hashAddressForKey(userEmail)"),
            value("messageId"),
          ),
          key("lock", value("emailAccountId")),
          person,
        ].join(";"),
      ),
    ).toEqual([named, person]);
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
  return listSources()
    .flatMap(({ file, source }) => {
      if (!CACHE_PRIMITIVE.test(source)) return [];
      const writes = countWrites(source);
      // A file that only reads, or only calls helpers recorded on their own,
      // has nothing of its own to record.
      return writes || file in SERVER_CACHE_WRITES ? [{ file, writes }] : [];
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function listSources() {
  return SCAN_ROOTS.flatMap((root) =>
    listFiles(root).map((file) => ({
      file: relative(file),
      source: withoutComments(readFileSync(file, "utf8")),
    })),
  );
}

function riskyKeyTemplates(source: string) {
  return [...withoutComments(source).matchAll(KEY_TEMPLATE)].flatMap(
    (match) => {
      const values = [...match[1].matchAll(/\$\{([^}]*)\}/g)].map((value) =>
        value[1].trim(),
      );
      const risky = values.some(
        (value) =>
          !/hash|sha256|digest/i.test(value) &&
          RISKY_VALUE.test(value.replace(/\?/g, "")),
      );
      return risky ? [match[0]] : [];
    },
  );
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
  try {
    statSync(dir);
  } catch {
    return [];
  }
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return SKIP_DIRS.has(name) ? [] : listFiles(full);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)
      ? [full]
      : [];
  });
}

// Paths in apps/web are relative to it; packages keep their packages/ prefix.
function relative(file: string) {
  const root = file.startsWith(WEB_ROOT) ? WEB_ROOT : REPO_ROOT;
  return path.relative(root, file).split(path.sep).join("/");
}
