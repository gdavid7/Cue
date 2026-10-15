import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { Redis as HttpRedis } from "@upstash/redis";
import type { UIMessageStreamWriter } from "ai";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRedisHttpServer } from "@/scripts/local-dev/redis-http";
import { createTestLogger } from "@/__tests__/helpers";
import {
  createLocalMailSearch,
  saveLocalMailSearchResult,
} from "@/utils/ai/assistant/local-mail-search";

// The module's Lua runs unchanged against a private redis-server, through the
// Upstash REST client as in production.
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
const TOKEN = "local-mail-search-test-token";
const ACCOUNT = "account-1";
const answer = {
  status: "ok" as const,
  messages: [
    {
      id: "m1",
      threadId: "t1",
      subject: "Next steps",
      from: "jobs@acme.com",
      to: "me@example.com",
      snippet: "Thanks",
      date: "2026-10-02T12:00:00.000Z",
      labelIds: ["INBOX"],
      hasAttachments: false,
    },
  ],
};

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "local mail search answers against a private Redis",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      const port = await freePort();
      server = spawn(
        REDIS_SERVER,
        ["--port", String(port), "--bind", "127.0.0.1", "--save", ""],
        { stdio: "ignore" },
      );
      redis = new Redis({ port, host: "127.0.0.1", lazyConnect: true });
      await vi.waitFor(() => redis!.connect(), { timeout: 10_000 });
      http = await createRedisHttpServer({ redis, token: TOKEN });
      upstash.client = new HttpRedis({ url: http.url, token: TOKEN });
    });
    afterAll(async () => {
      await http?.close();
      redis?.disconnect();
      server?.kill();
    });

    it("takes the first answer to an open request, keeps its expiry, and deletes it once read", async () => {
      const keys: string[] = [];
      const saved: boolean[] = [];
      const search = createLocalMailSearch({
        emailAccountId: ACCOUNT,
        logger: createTestLogger(),
        pollIntervalMs: 10,
      });
      search.attach({
        write: (part: { data: { requestId: string } }) => {
          keys.push(`assistant-local-search:${ACCOUNT}:${part.data.requestId}`);
          setTimeout(async () => {
            saved.push(
              await saveLocalMailSearchResult({
                emailAccountId: ACCOUNT,
                requestId: part.data.requestId,
                result: answer,
              }),
            );
            expect(await redis!.pttl(keys[0])).toBeGreaterThan(0);
            saved.push(
              await saveLocalMailSearchResult({
                emailAccountId: ACCOUNT,
                requestId: part.data.requestId,
                result: { status: "unavailable", reason: "error" },
              }),
            );
          }, 5);
        },
      } as unknown as UIMessageStreamWriter);

      expect(await search.search({ query: "x", limit: 20 })).toEqual(answer);
      await vi.waitFor(() => expect(saved).toEqual([true, false]));
      expect(await redis!.exists(keys[0])).toBe(0);
    });

    it("refuses an answer for a request that was never opened", async () => {
      expect(
        await saveLocalMailSearchResult({
          emailAccountId: ACCOUNT,
          requestId: "8d4a1f8e-5f5c-4b9b-9a51-4f1f0e7a2c11",
          result: answer,
        }),
      ).toBe(false);
      expect(await redis!.dbsize()).toBe(0);
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
