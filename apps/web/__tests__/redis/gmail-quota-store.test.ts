import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { Redis as HttpRedis } from "@upstash/redis";
import Redis from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRedisHttpServer } from "@/scripts/local-dev/redis-http";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import {
  GmailCallDeferredError,
  meterGmailCall,
  runWithGmailQuota,
  setGmailInitialSync,
} from "@/utils/gmail/quota";

// The store talks to Redis through the Upstash REST client, as in production;
// here that client points at the local Redis-over-HTTP shim in front of a
// private redis-server, so the production Lua runs unchanged.
const upstash = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/utils/redis", () => ({
  redis: new Proxy(
    {},
    {
      get: (_, property) => {
        const client = upstash.client as Record<PropertyKey, unknown>;
        const value = client[property];
        return typeof value === "function" ? value.bind(client) : value;
      },
    },
  ),
}));
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
}));

const REDIS_SERVER = "/usr/bin/redis-server";
const TOKEN = "gmail-quota-test-token";
const keys = {
  bucket: "gmail-quota:test:bucket",
  usage: "gmail-quota:test:usage:1",
  pause: "gmail-quota:test:background-pause",
  pace: "gmail-quota:test:pace",
  demand: "gmail-quota:test:interactive-demand",
};
const take = (input: {
  cost: number;
  floor: number;
  blockers?: { key: string; deferMs?: number }[];
  usageField?: string;
  paceCap?: number;
  demand?: {
    key: string;
    yieldCap?: number;
    markMs?: number;
    everyMs?: number;
  };
}) => admit(input).then(({ waitMs }) => waitMs);
const admit = (input: {
  cost: number;
  floor: number;
  blockers?: { key: string; deferMs?: number }[];
  usageField?: string;
  paceCap?: number;
  demand?: {
    key: string;
    yieldCap?: number;
    markMs?: number;
    everyMs?: number;
  };
}) =>
  gmailQuotaStore.take({
    bucketKey: keys.bucket,
    usageKey: keys.usage,
    usageField: input.usageField ?? "sync:test",
    blockers: input.blockers ?? [],
    cost: input.cost,
    capacity: 1000,
    perMinute: 3600,
    floor: input.floor,
    // Out of the way unless a case is about the per-second pace.
    pace: {
      key: keys.pace,
      cap: input.paceCap ?? 100_000,
      windowMs: 1000,
      demand: input.demand ?? { key: keys.demand },
    },
  });

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "Gmail quota store against a private Redis",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      const port = await freePort();
      server = spawn(
        REDIS_SERVER,
        [
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        { stdio: "ignore" },
      );
      redis = new Redis({ port, host: "127.0.0.1", lazyConnect: true });
      await vi.waitFor(() => redis!.connect(), { timeout: 10_000 });
      http = await createRedisHttpServer({ redis, token: TOKEN });
      upstash.client = new HttpRedis({ url: http.url, token: TOKEN });
    });
    beforeEach(async () => {
      await redis!.flushdb();
    });
    afterAll(async () => {
      await http?.close();
      redis?.disconnect();
      server?.kill();
    });

    it("debits the bucket and records the caller's units when the floor holds", async () => {
      expect(await take({ cost: 300, floor: 200, usageField: "sync:a" })).toBe(
        0,
      );
      expect(await take({ cost: 300, floor: 200, usageField: "sync:a" })).toBe(
        0,
      );
      expect(
        Number(await redis!.hget(keys.bucket, "tokens")),
      ).toBeGreaterThanOrEqual(400);
      expect(await redis!.hgetall(keys.usage)).toEqual({
        "sync:a": "600",
        "peak:second": "600",
      });
      expect(await redis!.pttl(keys.bucket)).toBeGreaterThan(0);
    });

    it("refuses a debit that would cross the floor and says how long the refill takes", async () => {
      expect(await take({ cost: 700, floor: 200 })).toBe(0);
      // About 300 tokens left; 200 + 300 needs another ~200, at 60 a second.
      const wait = await take({ cost: 300, floor: 200 });
      expect(wait).toBeGreaterThan(3000);
      expect(wait).toBeLessThanOrEqual(3400);
      // Nothing was debited or recorded for the refused call.
      expect(await redis!.hgetall(keys.usage)).toEqual({
        "sync:test": "700",
        "peak:second": "700",
      });
    });

    it("lets interactive calls overdraw into the reserved slice", async () => {
      expect(await take({ cost: 1000, floor: 200 })).toBe(0);
      expect(await take({ cost: 150, floor: -200 })).toBe(0);
      expect(Number(await redis!.hget(keys.bucket, "tokens"))).toBeLessThan(0);
      expect(await take({ cost: 150, floor: -200 })).toBeGreaterThan(0);
    });

    it("asks a request larger than the bucket only for the bucket above its floor", async () => {
      expect(await take({ cost: 5000, floor: 500 })).toBe(0);
      expect(
        Number(await redis!.hget(keys.bucket, "tokens")),
      ).toBeLessThanOrEqual(-3900);
    });

    it("holds callers behind a blocker for its remaining time", async () => {
      await gmailQuotaStore.block({ key: keys.pause, ms: 20_000 });
      const wait = await take({
        cost: 10,
        floor: 500,
        blockers: [{ key: keys.pause }],
      });
      expect(wait).toBeGreaterThan(19_000);
      expect(wait).toBeLessThanOrEqual(20_000);
      // A shorter block never shortens a longer one.
      await gmailQuotaStore.block({ key: keys.pause, ms: 1000 });
      expect(await redis!.pttl(keys.pause)).toBeGreaterThan(19_000);
      await gmailQuotaStore.clear(keys.pause);
      expect(
        await take({ cost: 10, floor: 500, blockers: [{ key: keys.pause }] }),
      ).toBe(0);
    });

    it("defers callers behind a blocker that lifts early, asking them back soon", async () => {
      await gmailQuotaStore.block({ key: keys.pause, ms: 90_000 });
      const blockers = [{ key: keys.pause, deferMs: 5000 }];
      expect(await admit({ cost: 10, floor: 500, blockers })).toEqual({
        waitMs: 5000,
        defer: true,
      });
      await gmailQuotaStore.clear(keys.pause);
      expect(await admit({ cost: 10, floor: 500, blockers })).toEqual({
        waitMs: 0,
        defer: false,
      });
    });

    it("holds any one second to the pace cap and records the busiest second", async () => {
      expect(await take({ cost: 60, floor: 200, paceCap: 120 })).toBe(0);
      expect(await take({ cost: 60, floor: 200, paceCap: 120 })).toBe(0);
      // A third request waits for the first of the second to age out.
      const wait = await take({ cost: 60, floor: 200, paceCap: 120 });
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(1001);
      // A higher cap still has room in the same second.
      expect(await take({ cost: 60, floor: -200, paceCap: 200 })).toBe(0);
      expect(Number(await redis!.hget(keys.usage, "peak:second"))).toBe(180);
    });

    it("holds others to their yield cap while a person's demand lasts", async () => {
      const person = { key: keys.demand, markMs: 2000, everyMs: 3000 };
      const sync = { key: keys.demand, yieldCap: 40 };
      const background = { key: keys.demand, yieldCap: 0 };
      expect(
        await take({ cost: 20, floor: -200, paceCap: 200, demand: person }),
      ).toBe(0);
      expect(await redis!.pttl(keys.demand)).toBeGreaterThan(2900);
      // Sync fits 20 more units this second, not the 100 its cap would allow.
      expect(
        await take({ cost: 20, floor: 200, paceCap: 120, demand: sync }),
      ).toBe(0);
      const held = await take({
        cost: 40,
        floor: 200,
        paceCap: 120,
        demand: sync,
      });
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(1001);
      // Background waits until the demand ends.
      const waiting = await take({
        cost: 20,
        floor: 500,
        paceCap: 80,
        demand: background,
      });
      expect(waiting).toBeGreaterThan(1900);
      await redis!.del(keys.demand);
      expect(
        await take({ cost: 20, floor: 500, paceCap: 80, demand: background }),
      ).toBe(0);
    });

    it("hands a minute's usage to exactly one caller", async () => {
      await gmailQuotaStore.note({
        usageKey: keys.usage,
        field: "deferred:user/stats",
        amount: 2,
      });
      expect(await take({ cost: 40, floor: -200, usageField: "chat" })).toBe(0);
      const claim = () =>
        gmailQuotaStore.claimUsages([
          { usageKey: keys.usage, claimKey: `${keys.usage}:logged` },
          {
            usageKey: "gmail-quota:test:usage:2",
            claimKey: "gmail-quota:test:usage:2:logged",
          },
        ]);
      expect(await claim()).toEqual([
        { "deferred:user/stats": 2, chat: 40, "peak:second": 40 },
        null,
      ]);
      expect(await claim()).toEqual([null, null]);
      // A minute with no usage is not marked claimed.
      expect(await redis!.exists("gmail-quota:test:usage:2:logged")).toBe(0);
    });

    it("runs the gate end to end: a first sync holds background work but not a thread open", async () => {
      await setGmailInitialSync("account-real", true);
      await expect(
        runWithGmailQuota(
          { caller: "user/inbox-insights", priority: "background" },
          () =>
            meterGmailCall(
              { emailAccountId: "account-real", cost: 20 },
              async () => "insight",
            ),
        ),
      ).rejects.toBeInstanceOf(GmailCallDeferredError);
      await expect(
        runWithGmailQuota(
          {
            caller: "mail/v1/conversation-membership",
            priority: "interactive",
          },
          () =>
            meterGmailCall(
              { emailAccountId: "account-real", cost: 40 },
              async () => "thread",
            ),
        ),
      ).resolves.toBe("thread");
      await setGmailInitialSync("account-real", false);
      await expect(
        runWithGmailQuota(
          { caller: "user/inbox-insights", priority: "background" },
          () =>
            meterGmailCall(
              { emailAccountId: "account-real", cost: 20 },
              async () => "insight",
            ),
        ),
      ).resolves.toBe("insight");
    });
  },
);

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}
