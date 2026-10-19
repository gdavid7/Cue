import { describe, expect, it } from "vitest";
import { hashAddressForKey } from "@/utils/redis/address-key";
import {
  type CleanupRedis,
  deletePiiCacheKeys,
  hashedClaimKey,
} from "./pii-cache-keys";

const HASH = "a".repeat(64);

describe("deletePiiCacheKeys", () => {
  it("deletes the keys that held mail or personal data and leaves the rest", async () => {
    const redis = fakeRedis({
      "summary:abc": "Renewal priced at $48k",
      "thread-brief:a1:t1:m1": { summary: "Sarah asks about Friday" },
      "inbox-insight:a1:m1": { people: [{ email: "sarah@acme.com" }] },
      "thread:a1:job1:t1": { subject: "Invoice", from: "billing@acme.com" },
      "account:u1:a1": "me@example.com",
      "meeting-news:acme.com": [{ title: "Acme raises prices" }],
      [`meeting-news:${HASH}`]: [{ title: "Acme raises prices" }],
      "inbox-zero:chat-sdk:list:msg-history:telegram-1": [{ text: "Rent" }],
      "usage-weekly-cost:me@example.com:2026-10-18": { cost: 1 },
      "usage-weekly-cost:user:u1:2026-10-18": { cost: 1 },
      "rate-limit:inbox-insights:u1": 3,
      "contact-photos-paused:a1": "1",
      "usage:me@example.com": { cost: 4 },
    });

    await deletePiiCacheKeys({ redis: redis.client });

    expect([...redis.store.keys()].sort()).toEqual(
      [
        `meeting-news:${HASH}`,
        "usage-weekly-cost:user:u1:2026-10-18",
        "rate-limit:inbox-insights:u1",
        "contact-photos-paused:a1",
        // Lifetime counters go only when asked for.
        "usage:me@example.com",
      ].sort(),
    );
  });

  it("deletes the legacy usage counters only when asked", async () => {
    const redis = fakeRedis({ "usage:me@example.com": { cost: 4 } });

    await deletePiiCacheKeys({ redis: redis.client, includeLegacyUsage: true });

    expect(redis.store.size).toBe(0);
  });

  it("moves a message claim to its hashed key, so a handled message stays handled", async () => {
    const redis = fakeRedis({
      "processing-message:me@example.com:m1": "processed",
      [`processing-message:${hashAddressForKey("me@example.com")}:m2`]:
        "lock-token",
      "processing-message:me@example.com:m2": "processed",
    });

    await deletePiiCacheKeys({ redis: redis.client });

    expect(Object.fromEntries(redis.store)).toEqual({
      [`processing-message:${hashAddressForKey("me@example.com")}:m1`]:
        "processed",
      // The newer claim under the hashed key wins.
      [`processing-message:${hashAddressForKey("me@example.com")}:m2`]:
        "lock-token",
    });
  });

  it("changes nothing on a dry run, and nothing more on a second run", async () => {
    const redis = fakeRedis({
      "reply:a1:m1": "Happy to meet",
      "processing-message:me@example.com:m1": "processed",
    });

    const planned = await deletePiiCacheKeys({
      redis: redis.client,
      dryRun: true,
    });
    expect(redis.store.size).toBe(2);
    expect(planned["reply:*"]).toBe(1);

    await deletePiiCacheKeys({ redis: redis.client });
    const again = await deletePiiCacheKeys({ redis: redis.client });

    expect(Object.values(again).every((count) => count === 0)).toBe(true);
  });

  it("pages through SCAN instead of asking for every key at once", async () => {
    const keys = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`linked-page:${i}`, "page"]),
    );
    const redis = fakeRedis(keys, 40);

    await deletePiiCacheKeys({ redis: redis.client });

    expect(redis.store.size).toBe(0);
    expect(redis.scans).toBeGreaterThan(5);
  });
});

describe("hashedClaimKey", () => {
  it("hashes the address and keeps the message id", () => {
    expect(hashedClaimKey("processing-message:me@example.com:m1")).toBe(
      `processing-message:${hashAddressForKey("me@example.com")}:m1`,
    );
    expect(hashedClaimKey(`processing-message:${HASH}:m1`)).toBeNull();
  });
});

function fakeRedis(initial: Record<string, unknown>, pageSize = 1000) {
  const store = new Map(Object.entries(initial));
  // Like Redis, a scan returns every key present from its start to its end,
  // even while keys are deleted along the way.
  const snapshots = new Map<string, string[]>();
  let scans = 0;
  const client: CleanupRedis = {
    async scan(cursor, { match }) {
      scans++;
      const pattern = new RegExp(
        `^${match.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      );
      if (Number(cursor) === 0)
        snapshots.set(
          match,
          [...store.keys()].filter((key) => pattern.test(key)).sort(),
        );
      const all = snapshots.get(match) ?? [];
      const start = Number(cursor);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize >= all.length ? 0 : start + pageSize;
      return [String(next), page];
    },
    async unlink(...keys) {
      return keys.filter((key) => store.delete(key)).length;
    },
    async renamenx(source, destination) {
      if (store.has(destination) || !store.has(source)) return 0;
      store.set(destination, store.get(source));
      store.delete(source);
      return 1;
    },
  };
  return {
    client,
    store,
    get scans() {
      return scans;
    },
  };
}
