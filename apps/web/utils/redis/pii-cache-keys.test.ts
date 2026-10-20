import { describe, expect, it, vi } from "vitest";
import { hashAddressForKey } from "@/utils/redis/address-key";
import {
  type CleanupRedis,
  deletePiiCacheKeys,
  hashedClaimKey,
  PII_KEY_PATTERNS,
  runPiiCleanupStep,
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
      "usage:email-account:a1": { cost: 4 },
      "account-owner:u1:a1": "1",
      "inbox-zero:chat-sdk:cache:modal-context:slack:1": { text: "Rent" },
      "inbox-zero:chat-sdk:cache:callback:abc": { url: "https://x.test" },
    });

    await deletePiiCacheKeys({ redis: redis.client });

    expect([...redis.store.keys()].sort()).toEqual(
      [
        `meeting-news:${HASH}`,
        "usage-weekly-cost:user:u1:2026-10-18",
        "rate-limit:inbox-insights:u1",
        "contact-photos-paused:a1",
        "usage:email-account:a1",
        // The id-only ownership flag that replaced account:{user}:{acct}.
        "account-owner:u1:a1",
        "inbox-zero:chat-sdk:cache:callback:abc",
      ].sort(),
    );
  });

  it("rewrites weekly-spend migration records by day, without addresses", async () => {
    const redis = fakeRedis({
      "usage-migration:weekly-usage-cost-user:u1:done": JSON.stringify({
        weeklyCosts: {
          "usage-weekly-cost:me@example.com:2026-10-18": 1.5,
          "usage-weekly-cost:me@work.example:2026-10-18": 0.5,
          "usage-weekly-cost:me@example.com:2026-10-17": 2,
        },
      }),
    });

    await deletePiiCacheKeys({ redis: redis.client });
    const again = await deletePiiCacheKeys({ redis: redis.client });

    expect(
      JSON.parse(
        String(
          redis.store.get("usage-migration:weekly-usage-cost-user:u1:done"),
        ),
      ),
    ).toEqual({ weeklyCostsByDay: { "2026-10-18": 2, "2026-10-17": 2 } });
    expect(again["usage-migration:weekly-usage-cost-user:*:done"]).toBe(0);
  });

  it("rewrites a weekly migration record stored in the object shape", async () => {
    const redis = fakeRedis({
      "usage-migration:weekly-usage-cost-user:u1:done": {
        weeklyCosts: { "usage-weekly-cost:me@example.com:2026-10-18": 1.5 },
      },
    });

    await deletePiiCacheKeys({ redis: redis.client });

    expect(
      JSON.stringify(
        redis.store.get("usage-migration:weekly-usage-cost-user:u1:done"),
      ),
    ).not.toContain("@");
  });

  it("moves a message claim to its hashed key, so a handled message stays handled", async () => {
    const redis = fakeRedis({
      "processing-message:me@example.com:m1": "processed",
      [`processing-message:${hashAddressForKey("me@example.com")}:m2`]:
        "lock-token",
      "processing-message:me@example.com:m2": "processed",
      // A run on an older deploy still holds this one; it expires with it.
      "processing-message:me@example.com:m3": "live-lock-token",
    });

    await deletePiiCacheKeys({ redis: redis.client });

    expect(Object.fromEntries(redis.store)).toEqual({
      [`processing-message:${hashAddressForKey("me@example.com")}:m1`]:
        "processed",
      // The newer claim under the hashed key wins.
      [`processing-message:${hashAddressForKey("me@example.com")}:m2`]:
        "lock-token",
      "processing-message:me@example.com:m3": "live-lock-token",
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

describe("runPiiCleanupStep", () => {
  it("keeps the ids-only Deep Clean threads that are still written", async () => {
    const redis = fakeRedis({
      "thread:a1:job1:t1": { threadId: "t1", status: "processing" },
      "thread:a1:job1:t2": { threadId: "t2", from: "billing@acme.com" },
    });

    const { counts } = await runPiiCleanupStep({
      redis: redis.client,
      dryRun: false,
    });

    expect(counts["thread:*"]).toBe(1);
    expect([...redis.store.keys()]).toEqual(["thread:a1:job1:t1"]);
  });

  it("counts on a dry run without deleting, renaming or rewriting", async () => {
    const redis = fakeRedis({
      "reply:a1:m1": "Happy to meet",
      "usage:me@example.com": { cost: 4 },
      "processing-message:me@example.com:m1": "processed",
    });
    const unlink = vi.spyOn(redis.client, "unlink");
    const set = vi.spyOn(redis.client, "set");
    const renamenx = vi.spyOn(redis.client, "renamenx");

    const { counts, nextCursor } = await runPiiCleanupStep({
      redis: redis.client,
      dryRun: true,
    });

    expect(nextCursor).toBeNull();
    expect(counts["reply:*"]).toBe(1);
    expect(counts["usage:*@*"]).toBe(1);
    expect(counts["processing-message:*@*"]).toBe(1);
    expect(redis.store.size).toBe(3);
    expect(unlink).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(renamenx).not.toHaveBeenCalled();
  });

  it("only scans and deletes the listed patterns, so a decoy survives", async () => {
    const redis = fakeRedis({
      "reply:a1:m1": "Happy to meet",
      "reply-tracker:outbound-thread-status:a1:t1:m1": "1",
      "summary-limit:a1": "1",
      "digest:summary-limit:a1": "1",
      "usage:email-account:a1": { cost: 1 },
      "decoy:me@example.com": "keep",
    });
    const scanned = new Set<string>();
    const scan = redis.client.scan;
    redis.client.scan = (cursor, options) => {
      scanned.add(options.match);
      return scan(cursor, options);
    };

    await runPiiCleanupStep({ redis: redis.client, dryRun: false });

    expect([...redis.store.keys()].sort()).toEqual([
      "decoy:me@example.com",
      "digest:summary-limit:a1",
      "reply-tracker:outbound-thread-status:a1:t1:m1",
      "summary-limit:a1",
      "usage:email-account:a1",
    ]);
    const listed = new Set([
      ...PII_KEY_PATTERNS.map((pattern) => pattern.match),
      "processing-message:*@*",
      "usage-migration:weekly-usage-cost-user:*:done",
    ]);
    expect(scanned).toEqual(listed);
  });

  it("stops at the time budget with a cursor, and resumes to finish", async () => {
    const keys = Object.fromEntries([
      ...Array.from({ length: 700 }, (_, i) => [`linked-page:${i}`, "page"]),
      ...Array.from({ length: 5 }, (_, i) => [`reply:a1:${i}`, "text"]),
    ]);
    const redis = fakeRedis(keys, 300);
    // Every clock read is 10ms later, so a 15ms budget allows two batches.
    let tick = 0;
    const now = () => (tick += 10);

    const totals: Record<string, number> = {};
    let cursor: string | null = null;
    let calls = 0;
    do {
      const step: Awaited<ReturnType<typeof runPiiCleanupStep>> =
        await runPiiCleanupStep({
          redis: redis.client,
          dryRun: false,
          cursor,
          budgetMs: 15,
          now,
        });
      for (const [match, count] of Object.entries(step.counts))
        totals[match] = (totals[match] ?? 0) + count;
      cursor = step.nextCursor;
      calls++;
      if (cursor) expect(cursor).toMatch(/^\d+:\d+$/);
    } while (cursor);

    expect(calls).toBeGreaterThan(1);
    expect(totals["linked-page:*"]).toBe(700);
    expect(totals["reply:*"]).toBe(5);
    expect(redis.store.size).toBe(0);
  });

  it("makes progress even with a zero budget", async () => {
    const redis = fakeRedis({ "summary:1": "x" });

    const first = await runPiiCleanupStep({
      redis: redis.client,
      dryRun: false,
      budgetMs: 0,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toBe("0:0");
  });

  it("rejects a cursor it did not hand out", async () => {
    const redis = fakeRedis({});

    await expect(
      runPiiCleanupStep({ redis: redis.client, dryRun: true, cursor: "99:0" }),
    ).rejects.toThrow("Invalid cleanup cursor");
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
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
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
