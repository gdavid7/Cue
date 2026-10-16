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
import { getUsage, getWeeklyUsageCost, saveUsage } from "@/utils/redis/usage";

// AI usage is written and read on every model call, so its Lua runs here
// unchanged against a private redis-server, through the Upstash REST client
// as in production, and each billed command is counted.
const upstash = vi.hoisted(() => ({ client: null as unknown, commands: 0 }));
vi.mock("@/utils/redis", () => ({
  redis: new Proxy(
    {},
    {
      get: (_, property) => {
        const client = upstash.client as Record<PropertyKey, unknown>;
        const value = client[property];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          upstash.commands += 1;
          return (value as (...a: unknown[]) => unknown).apply(client, args);
        };
      },
    },
  ),
}));

const REDIS_SERVER = "/usr/bin/redis-server";
const TOKEN = "usage-store-test-token";
const NOW = new Date("2026-02-24T15:00:00.000Z");
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  inputTokenDetails: { cacheReadTokens: 40 },
  outputTokenDetails: { reasoningTokens: 5 },
} as never;

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "AI usage store against a private Redis",
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
      upstash.commands = 0;
    });
    afterAll(async () => {
      await http?.close();
      redis?.disconnect();
      server?.kill();
    });

    it("saves a call's usage to the account, the user and the week in one command", async () => {
      await saveUsage({
        userId: "user-1",
        emailAccountId: "account-1",
        usage,
        cost: 0.25,
        now: NOW,
      });
      await saveUsage({
        userId: "user-1",
        emailAccountId: "account-1",
        usage,
        cost: 0.5,
        now: NOW,
      });

      expect(upstash.commands).toBe(2);
      const expected = {
        calls: 2,
        tokensUsed: 240,
        promptTokensUsed: 200,
        completionTokensUsed: 40,
        cachedInputTokensUsed: 80,
        reasoningTokensUsed: 10,
        cost: 0.75,
      };
      expect(await getUsage({ emailAccountId: "account-1" })).toEqual(expected);
      expect(
        await redis!.hgetall("usage:user:user-1").then((hash) => hash.calls),
      ).toBe("2");
      const weekly = "usage-weekly-cost:user:user-1:2026-02-24";
      expect(Number(await redis!.hget(weekly, "cost"))).toBeCloseTo(0.75);
      expect(await redis!.ttl(weekly)).toBeGreaterThan(7 * 24 * 60 * 60);
    });

    it("counts a free call without touching the weekly spend", async () => {
      await saveUsage({
        emailAccountId: "account-1",
        usage: { totalTokens: 10 } as never,
        cost: 0,
        now: NOW,
      });

      expect(await getUsage({ emailAccountId: "account-1" })).toEqual({
        calls: 1,
        tokensUsed: 10,
      });
      expect(await redis!.keys("usage-weekly-cost:*")).toEqual([]);
    });

    it("reads a week of spend, legacy keys included, in a fixed number of commands", async () => {
      await redis!.hset(
        "usage-weekly-cost:user:user-1:2026-02-24",
        "cost",
        "1.5",
      );
      await redis!.hset(
        "usage-weekly-cost:user:user-1:2026-02-18",
        "cost",
        "0.5",
      );
      // Outside the 7-day window.
      await redis!.hset(
        "usage-weekly-cost:user:user-1:2026-02-17",
        "cost",
        "9",
      );
      await redis!.set(
        "usage-migration:weekly-usage-cost-user:user-1:done",
        JSON.stringify({ weeklyCosts: {} }),
      );

      const weeklyCost = await getWeeklyUsageCost({
        userId: "user-1",
        legacyEmails: ["a@example.com", "b@example.com"],
        now: NOW,
      });

      expect(weeklyCost).toBeCloseTo(2);
      // The legacy hashes, the user's week and the migration marker.
      expect(upstash.commands).toBe(3);
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
