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
import {
  type GmailQuotaNote,
  gmailQuotaStore,
} from "@/utils/gmail/quota-store";
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
  slow: "gmail-quota:test:background-slow",
  budget: "gmail-quota:test:budget",
  trailing: "gmail-quota:test:trailing",
};
const take = (input: {
  cost: number;
  floor: number;
  blockers?: { key: string; deferMs?: number }[];
  usageField?: string;
  paceCap?: number;
  slowKey?: string;
  waitBudgetMs?: number;
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
  slowKey?: string;
  waitBudgetMs?: number;
  demand?: {
    key: string;
    yieldCap?: number;
    markMs?: number;
    everyMs?: number;
  };
  queued?: { cost: number; field: string }[];
  ahead?: { units: number; step: number; leaseMs: number; share: number };
  notes?: { field: string; amount: number }[];
  release?: { reservation: string; kept: number; soonerMs: number }[];
}) =>
  gmailQuotaStore.take({
    bucketKey: keys.bucket,
    usageKey: keys.usage,
    usageField: input.usageField ?? "sync:test",
    blockers: input.blockers ?? [],
    cost: input.cost,
    capacity: 1000,
    budget: {
      key: keys.budget,
      trailingKey: keys.trailing,
      trailingWindowMs: 60_000,
      start: 3600,
      max: 12_000,
      raiseFactor: 1.1,
      raiseEveryMs: 600_000,
    },
    floor: input.floor,
    waitBudgetMs: input.waitBudgetMs,
    // Out of the way unless a case is about the per-second pace.
    pace: {
      key: keys.pace,
      cap: input.paceCap ?? 100_000,
      windowMs: 1000,
      slowKey: input.slowKey,
      demand: input.demand ?? { key: keys.demand },
    },
    queued: input.queued,
    ahead: input.ahead,
    notes: input.notes,
    release: input.release,
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
        "budget:perMinute": "3600",
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
        "budget:perMinute": "3600",
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
      expect(await admit({ cost: 10, floor: 500, blockers })).toMatchObject({
        waitMs: 5000,
        defer: true,
      });
      await gmailQuotaStore.clear(keys.pause);
      expect(await admit({ cost: 10, floor: 500, blockers })).toMatchObject({
        waitMs: 0,
        defer: false,
      });
    });

    it("says which gate held a call", async () => {
      await gmailQuotaStore.block({ key: keys.pause, ms: 90_000 });
      expect(
        (
          await admit({
            cost: 10,
            floor: 500,
            blockers: [{ key: "gmail-quota:test:other" }, { key: keys.pause }],
          })
        ).held,
      ).toMatchObject({ gate: "blocker", blocker: 2 });
      await gmailQuotaStore.clear(keys.pause);

      // 1000 capacity with a floor of 500 leaves room for one 500 call only.
      await admit({ cost: 500, floor: 500 });
      expect((await admit({ cost: 100, floor: 500 })).held).toMatchObject({
        gate: "bucket",
        neededUnits: 600,
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

    it("refills at the account's budget, cut to what it let through and raised after quiet periods", async () => {
      const cut = () =>
        gmailQuotaStore.cutBudget({
          key: keys.budget,
          trailingKey: keys.trailing,
          trailingWindowMs: 60_000,
          start: 3600,
          fraction: 0.85,
          floor: 1200,
        });
      // Starts at its start, and records it with the minute's usage.
      expect(await take({ cost: 1000, floor: -200 })).toBe(0);
      expect(await redis!.hget(keys.budget, "perMinute")).toBe("3600");
      expect(Number(await redis!.hget(keys.usage, "budget:perMinute"))).toBe(
        3600,
      );
      for (let i = 0; i < 4; i++)
        expect(await take({ cost: 500, floor: -100_000 })).toBe(0);
      // 3,000 units in the trailing minute: 85% of them.
      expect(await cut()).toBe(2550);
      // The bucket, 2,000 units overdrawn, now refills at 2,550 a minute:
      // 2,300 units take about 54 s.
      const wait = await take({ cost: 300, floor: 0 });
      expect(wait).toBeGreaterThan(53_500);
      expect(wait).toBeLessThanOrEqual(54_200);
      // A cut never raises the budget, and never goes below the floor.
      await redis!.del(keys.trailing);
      expect(await cut()).toBe(1200);
      // Two quiet periods later it is up two tenths, compounded.
      await redis!.hset(keys.budget, "at", String(Date.now() - 1_250_000));
      await take({ cost: 1, floor: -100_000 });
      expect(await redis!.hget(keys.budget, "perMinute")).toBe("1452");
    });

    it("halves the pace cap while the slow key is set, still honouring blockers", async () => {
      const slowed = {
        cost: 20,
        floor: 500,
        paceCap: 40,
        slowKey: keys.slow,
        blockers: [{ key: keys.pause }],
      };
      await gmailQuotaStore.block({ key: keys.slow, ms: 600_000 });
      expect(await take(slowed)).toBe(0);
      // Half of 40 a second: the next message waits for the second to pass.
      expect(await take(slowed)).toBeGreaterThan(0);
      await gmailQuotaStore.clear(keys.slow);
      expect(await take(slowed)).toBe(0);
      await gmailQuotaStore.block({ key: keys.pause, ms: 20_000 });
      await redis!.del(keys.pace);
      expect(await take(slowed)).toBeGreaterThan(19_000);
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

    it("starts a person's demand while their request still waits for room", async () => {
      const person = { key: keys.demand, markMs: 2000, everyMs: 3000 };
      expect(await take({ cost: 160, floor: 200, paceCap: 160 })).toBe(0);
      // The second is too full for the person's batch, so it waits...
      expect(
        await take({ cost: 100, floor: -200, paceCap: 200, demand: person }),
      ).toBeGreaterThan(0);
      // ...but sync already gives way while it does.
      expect(await redis!.pttl(keys.demand)).toBeGreaterThan(2900);
    });

    it("starts no yield for a request that will give up before it is admitted", async () => {
      const person = { key: keys.demand, markMs: 2000, everyMs: 3000 };
      await gmailQuotaStore.block({ key: keys.pause, ms: 5000 });
      expect(
        await take({
          cost: 100,
          floor: -200,
          paceCap: 200,
          blockers: [{ key: keys.pause }],
          demand: person,
          waitBudgetMs: 1000,
        }),
      ).toBeGreaterThan(1000);
      expect(await redis!.exists(keys.demand)).toBe(0);
    });

    it("holds a person's demand for a whole turn and releases only its own hold", async () => {
      const background = { key: keys.demand, yieldCap: 0 };
      const endsAt = await gmailQuotaStore.holdDemand({
        key: keys.demand,
        ms: 45_000,
        gapMs: 1000,
      });
      expect(endsAt).toBeGreaterThan(0);
      expect(
        await take({ cost: 20, floor: 500, paceCap: 80, demand: background }),
      ).toBeGreaterThan(40_000);
      // A shorter hold doesn't cut the longer one short.
      expect(
        await gmailQuotaStore.holdDemand({
          key: keys.demand,
          ms: 1000,
          gapMs: 1000,
        }),
      ).toBe(0);
      await gmailQuotaStore.releaseDemand({
        key: keys.demand,
        endsAt: endsAt - 1,
        gapMs: 1000,
      });
      expect(await redis!.exists(keys.demand)).toBe(1);

      await gmailQuotaStore.releaseDemand({
        key: keys.demand,
        endsAt,
        gapMs: 1000,
      });

      expect(
        await take({ cost: 20, floor: 500, paceCap: 80, demand: background }),
      ).toBe(0);
      // The next large request starts no episode until the gap has passed.
      const person = { key: keys.demand, markMs: 2000, everyMs: 3000 };
      expect(
        await take({ cost: 100, floor: -200, paceCap: 200, demand: person }),
      ).toBe(0);
      expect(await redis!.pttl(keys.demand)).toBeLessThanOrEqual(1000);
    });

    it("admits the requests queued behind one in the same round trip while each still fits", async () => {
      const result = await admit({
        cost: 30,
        floor: 200,
        paceCap: 100,
        usageField: "interactive:leader",
        queued: ["a", "b", "c"].map((name) => ({
          cost: 30,
          field: `interactive:${name}`,
        })),
      });
      // 30 + 30 + 30 fit the second's 100; a fourth 30 would not, and the
      // result says what it would be told, as asking itself does.
      expect(result).toEqual({
        waitMs: 0,
        defer: false,
        queued: 2,
        ahead: 0,
        reservation: null,
        nextWait: {
          waitMs: expect.any(Number),
          held: {
            gate: "pace",
            blocker: 0,
            availableUnits: expect.any(Number),
            neededUnits: 230,
            paceUnits: 90,
          },
        },
      });
      const asked = await admit({ cost: 30, floor: 200, paceCap: 100 });
      expect(asked.held).toEqual({
        ...result.nextWait?.held,
        // The bucket refills in the moment between the two.
        availableUnits: expect.any(Number),
      });
      expect(asked.held?.availableUnits).toBeGreaterThanOrEqual(
        result.nextWait!.held.availableUnits,
      );
      expect(
        asked.held!.availableUnits - result.nextWait!.held.availableUnits,
      ).toBeLessThan(5);
      expect(asked.waitMs).toBeGreaterThan(0);
      expect(asked.waitMs).toBeLessThanOrEqual(result.nextWait!.waitMs);
      expect(result.nextWait!.waitMs - asked.waitMs).toBeLessThan(50);
      expect(
        await take({ cost: 20, floor: 200, paceCap: 100 }),
      ).toBeGreaterThan(0);
      // Each admitted caller's units are its own; the one left out has none.
      const usage = await redis!.hgetall(keys.usage);
      expect(usage).toMatchObject({
        "interactive:leader": "30",
        "interactive:a": "30",
        "interactive:b": "30",
        "peak:second": "90",
      });
      expect(usage["interactive:c"]).toBeUndefined();
      // The trailing minute counts what was sent.
      const trailing = await redis!.zrange(keys.trailing, "0", "-1");
      expect(
        trailing.map((member) => Number(member.split(":").at(-1))),
      ).toEqual([90]);
    });

    it("says how long the bucket holds the next request as it admits one, as asking then does", async () => {
      // 1,000 tokens at 60 a second: 500 leaves 500, and another 500 needs
      // 700 above the floor.
      const result = await admit({ cost: 500, floor: 200 });
      expect(result).toMatchObject({
        waitMs: 0,
        nextWait: {
          held: {
            gate: "bucket",
            blocker: 0,
            availableUnits: 500,
            neededUnits: 700,
            paceUnits: 500,
          },
        },
      });
      expect(result.nextWait!.waitMs).toBeGreaterThan(3000);
      expect(result.nextWait!.waitMs).toBeLessThanOrEqual(3400);

      const asked = await admit({ cost: 500, floor: 200 });
      expect(asked.held).toMatchObject({
        gate: "bucket",
        neededUnits: 700,
        paceUnits: 500,
      });
      expect(asked.waitMs).toBeLessThanOrEqual(result.nextWait!.waitMs);
      expect(result.nextWait!.waitMs - asked.waitMs).toBeLessThan(50);
    });

    it("reserves ahead only from the spare half of the second, held in the pace window until its lease ends", async () => {
      const ahead = { units: 100, step: 10, leaseMs: 500, share: 0.5 };
      const startedAt = Date.now();
      const result = await admit({ cost: 10, floor: 200, paceCap: 100, ahead });
      // Half of the 100 a second, less the call itself.
      expect(result).toMatchObject({
        waitMs: 0,
        defer: false,
        queued: 0,
        ahead: 40,
        reservation: expect.stringContaining(":ahead:40"),
      });
      // A reservation counts as sent until it is cut down.
      const trailing = await redis!.zrange(keys.trailing, "0", "-1");
      expect(
        trailing.map((member) => Number(member.split(":").at(-1))).sort(),
      ).toEqual([10, 40]);
      const reservation = (await redis!.zrange(keys.pace, "0", "-1")).find(
        (member) => member.includes(":ahead:"),
      );
      const reservedUntil = Number(
        await redis!.zscore(keys.pace, reservation!),
      );
      expect(reservedUntil).toBeGreaterThanOrEqual(startedAt + 400);
      // The second is half full, so another reservation gets nothing...
      expect(
        await admit({ cost: 10, floor: 200, paceCap: 100, ahead }),
      ).toMatchObject({ waitMs: 0, ahead: 0 });
      // ...and a call that needs the rest waits for the first to age out.
      expect(
        await take({ cost: 50, floor: 200, paceCap: 100 }),
      ).toBeGreaterThan(0);
    });

    it("reserves ahead only from the bucket's upper half", async () => {
      const result = await admit({
        cost: 10,
        floor: 200,
        ahead: { units: 600, step: 10, leaseMs: 500, share: 0.5 },
      });
      // 1,000 tokens, less the call, down to half the bucket.
      expect(result).toMatchObject({ waitMs: 0, ahead: 490 });
      expect(Number(await redis!.hget(keys.bucket, "tokens"))).toBeCloseTo(
        500,
        -1,
      );
    });

    it("reads blockers, queued callers, notes and releases from their own places in one call", async () => {
      const ahead = { units: 100, step: 10, leaseMs: 500, share: 0.5 };
      const first = await admit({ cost: 10, floor: 200, paceCap: 100, ahead });
      expect(first.ahead).toBe(40);
      const reservedAt = Number(
        await redis!.zscore(keys.pace, first.reservation!),
      );

      // Two blockers that are not set, so their defer times are read but not used.
      const other = "gmail-quota:test:other-pause";
      const result = await admit({
        cost: 10,
        floor: 200,
        paceCap: 100,
        usageField: "sync:leader",
        blockers: [
          { key: keys.pause, deferMs: 5000 },
          { key: other, deferMs: 7000 },
        ],
        queued: [
          { cost: 10, field: "sync:q1" },
          { cost: 10, field: "sync:q2" },
        ],
        notes: [{ field: "deferred:x", amount: 3 }],
        release: [{ reservation: first.reservation!, kept: 15, soonerMs: 300 }],
      });
      expect(result).toMatchObject({ waitMs: 0, defer: false, queued: 2 });
      expect(await redis!.hgetall(keys.usage)).toMatchObject({
        "sync:leader": "10",
        "sync:q1": "10",
        "sync:q2": "10",
        "deferred:x": "3",
      });
      // The unspent 25 left the window; the 15 spent stay, 300 ms sooner.
      expect(await redis!.zscore(keys.pace, first.reservation!)).toBeNull();
      const kept = `${first.reservation}:kept:15`;
      expect(Number(await redis!.zscore(keys.pace, kept))).toBe(
        reservedAt - 300,
      );
      // The trailing minute keeps the 15 spent, not the 40 reserved.
      expect(await redis!.zscore(keys.trailing, first.reservation!)).toBeNull();
      expect(await redis!.zscore(keys.trailing, kept)).not.toBeNull();

      // With the second blocker set, its own defer time comes back.
      await gmailQuotaStore.block({ key: other, ms: 60_000 });
      expect(
        await admit({
          cost: 10,
          floor: 200,
          blockers: [
            { key: keys.pause, deferMs: 5000 },
            { key: other, deferMs: 7000 },
          ],
          queued: [{ cost: 10, field: "sync:q3" }],
          notes: [{ field: "deferred:y", amount: 1 }],
        }),
      ).toMatchObject({ waitMs: 7000, defer: true, queued: 0 });
      expect(await redis!.hget(keys.usage, "deferred:y")).toBe("1");
      expect(await redis!.hget(keys.usage, "sync:q3")).toBeNull();
    });

    it("records batched usage notes even when nothing is admitted", async () => {
      await gmailQuotaStore.block({ key: keys.pause, ms: 20_000 });
      await admit({
        cost: 10,
        floor: 500,
        blockers: [{ key: keys.pause }],
        notes: [
          { field: "sync:a", amount: 15 },
          { field: "deferred:b", amount: 2 },
        ],
      });
      expect(await redis!.hgetall(keys.usage)).toEqual({
        "sync:a": "15",
        "deferred:b": "2",
      });
    });

    it("hands a minute's usage to exactly one caller", async () => {
      await gmailQuotaStore.note([
        { usageKey: keys.usage, field: "deferred:user/stats", amount: 2 },
      ]);
      expect(await take({ cost: 40, floor: -200, usageField: "chat" })).toBe(0);
      const claim = (notes: GmailQuotaNote[] = []) =>
        gmailQuotaStore.claimUsages(
          [
            { usageKey: keys.usage, claimKey: `${keys.usage}:logged` },
            {
              usageKey: "gmail-quota:test:usage:2",
              claimKey: "gmail-quota:test:usage:2:logged",
            },
          ],
          notes,
        );
      // Notes written with the claim count in what it hands over.
      expect(
        await claim([
          { usageKey: keys.usage, field: "interactive:a", amount: 5 },
        ]),
      ).toEqual([
        {
          "deferred:user/stats": 2,
          chat: 40,
          "interactive:a": 5,
          "peak:second": 40,
          "budget:perMinute": 3600,
        },
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
