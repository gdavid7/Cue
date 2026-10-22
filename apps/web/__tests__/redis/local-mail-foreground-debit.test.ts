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
  LocalMailSyncPausedError,
  debitLocalMailSyncBudget,
  withLocalMailSyncBudget,
} from "@/utils/email/local-mail-sync-budget";

// Foreground reads draw on the sync budget on every message open and search,
// so the debit's Lua runs here against a private redis-server through the
// Upstash REST client, and each billed command is counted.
const upstash = vi.hoisted(() => ({ client: null as unknown, commands: 0 }));
vi.mock("server-only", () => ({}));
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
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
  getEmailProviderRateLimitStateFromRedis: async () => null,
}));

const REDIS_SERVER = "/usr/bin/redis-server";
const TOKEN = "foreground-debit-test-token";

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "foreground debit of the local mail budget against a private Redis",
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

    it("debits the account and app buckets in one command, holding no lease", async () => {
      await debitLocalMailSyncBudget({
        emailAccountId: "account-1",
        provider: "google",
        cost: 1000,
      });

      expect(upstash.commands).toBe(1);
      const account = await redis!.hget(
        "local-mail-budget:google:account-1:total",
        "tokens",
      );
      expect(Number(account)).toBeCloseTo(9000, -1);
      expect(
        await redis!.exists("local-mail-budget:google:account-1:active"),
      ).toBe(0);
    });

    it("slows a background scan that follows the foreground reads", async () => {
      for (let i = 0; i < 9; i++)
        await debitLocalMailSyncBudget({
          emailAccountId: "account-1",
          provider: "google",
          cost: 1000,
        });

      await expect(
        withLocalMailSyncBudget(
          {
            emailAccountId: "account-1",
            provider: "google",
            priority: "backfill",
            cost: 1100,
          },
          async () => "page",
        ),
      ).rejects.toBeInstanceOf(LocalMailSyncPausedError);
    });

    it("does not overdraw a bucket that cannot pay", async () => {
      for (let i = 0; i < 11; i++)
        await debitLocalMailSyncBudget({
          emailAccountId: "account-1",
          provider: "google",
          cost: 1000,
        });

      const account = await redis!.hget(
        "local-mail-budget:google:account-1:total",
        "tokens",
      );
      expect(Number(account)).toBeGreaterThanOrEqual(0);
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
