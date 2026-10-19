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
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  failStaleMailBulkJob,
  type MailBulkJobState,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";

// A select-all job's Stop, undo and completion all hinge on the status
// compare-and-set, so its Lua runs here unchanged against a private
// redis-server, through the Upstash REST client as in production.
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

const REDIS_SERVER = "/usr/bin/redis-server";
const TOKEN = "mail-bulk-job-test-token";
const JOB_ID = "00000000-0000-4000-8000-000000000001";

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "mail bulk job store against a private Redis",
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

    it("moves the status only from an expected one", async () => {
      await mailBulkJobStore.create(JOB_ID, job({ status: "listing" }));

      await expect(
        mailBulkJobStore.transition(JOB_ID, ["applying"], "done"),
      ).resolves.toBe(false);
      expect((await mailBulkJobStore.get(JOB_ID))?.status).toBe("listing");

      await expect(
        mailBulkJobStore.transition(JOB_ID, ["listing"], "applying"),
      ).resolves.toBe(true);
      expect((await mailBulkJobStore.get(JOB_ID))?.status).toBe("applying");
    });

    it("keeps a Stop that lands while a delivery is moving the job on", async () => {
      await mailBulkJobStore.create(JOB_ID, job({ status: "listing" }));

      // Stop wins the race; the delivery's listing -> applying then misses.
      await expect(
        mailBulkJobStore.transition(
          JOB_ID,
          ACTIVE_MAIL_BULK_JOB_STATUSES,
          "stopping",
        ),
      ).resolves.toBe(true);
      await expect(
        mailBulkJobStore.transition(JOB_ID, ["listing"], "applying"),
      ).resolves.toBe(false);
      await expect(
        mailBulkJobStore.transition(JOB_ID, ["applying"], "done"),
      ).resolves.toBe(false);
      // Only the delivery's own settling ends it, as cancelled.
      await expect(
        mailBulkJobStore.transition(JOB_ID, ["stopping"], "cancelled"),
      ).resolves.toBe(true);
      expect((await mailBulkJobStore.get(JOB_ID))?.status).toBe("cancelled");
    });

    it("does nothing for a job that doesn't exist", async () => {
      await expect(
        mailBulkJobStore.transition(JOB_ID, ["listing"], "applying"),
      ).resolves.toBe(false);
      expect(await redis!.exists(`mail-bulk-job:${JOB_ID}`)).toBe(0);
    });

    it("stamps each write so a silent job reads as stale", async () => {
      await mailBulkJobStore.create(JOB_ID, job({ updatedAt: 1 }));
      await mailBulkJobStore.increment(JOB_ID, "applied", 5);

      const stored = await mailBulkJobStore.get(JOB_ID);
      expect(stored?.applied).toBe(5);
      expect(stored?.updatedAt).toBeGreaterThan(1);

      await redis!.hset(`mail-bulk-job:${JOB_ID}`, "updatedAt", "1");
      await mailBulkJobStore.touch(JOB_ID);
      expect((await mailBulkJobStore.get(JOB_ID))?.updatedAt).toBeGreaterThan(
        1,
      );
    });

    it("fails a stale job, but never one that already finished", async () => {
      await mailBulkJobStore.create(JOB_ID, job({ status: "stopping" }));
      await expect(failStaleMailBulkJob(JOB_ID)).resolves.toBe(true);
      expect((await mailBulkJobStore.get(JOB_ID))?.status).toBe("failed");

      await mailBulkJobStore.create(JOB_ID, job({ status: "done" }));
      await expect(failStaleMailBulkJob(JOB_ID)).resolves.toBe(false);
      expect((await mailBulkJobStore.get(JOB_ID))?.status).toBe("done");
    });

    it("keeps targets in order and counts each conversation once", async () => {
      await mailBulkJobStore.create(JOB_ID, job({}));

      await expect(
        mailBulkJobStore.appendTargets(JOB_ID, [
          { messageId: "m1", threadId: "t1" },
          { messageId: "m2", threadId: "t1" },
        ]),
      ).resolves.toBe(1);
      await expect(
        mailBulkJobStore.appendTargets(JOB_ID, [
          { messageId: "m3", threadId: "t1" },
          { messageId: "m4", threadId: "t2" },
        ]),
      ).resolves.toBe(1);

      await expect(mailBulkJobStore.readTargets(JOB_ID, 1, 2)).resolves.toEqual(
        [
          { messageId: "m2", threadId: "t1" },
          { messageId: "m3", threadId: "t1" },
        ],
      );
      expect(
        await redis!.ttl(`mail-bulk-job:${JOB_ID}:targets`),
      ).toBeGreaterThan(0);
    });
  },
);

function job(overrides: Partial<MailBulkJobState>): MailBulkJobState {
  return {
    emailAccountId: "account-1",
    action: "archive",
    status: "listing",
    total: 0,
    conversations: 0,
    applied: 0,
    failed: 0,
    capped: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

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
