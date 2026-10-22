import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { auth as gmailAuth } from "@googleapis/gmail";
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
import { createFakeGmail } from "@/__tests__/mocks/fake-gmail-quota";
import { createRedisHttpServer } from "@/scripts/local-dev/redis-http";
import { runWithAuditContext } from "@/utils/audit/context";
import { GmailProvider } from "@/utils/email/google";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { resetGmailInflightState } from "@/utils/gmail/inflight";
import { resetGmailQuotaInstanceState } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";
import {
  createRequestMetrics,
  runWithRequestMetrics,
} from "@/utils/request-metrics";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

// Every command the request sends goes through the production usage meter
// (which feeds `redisCalls`) and then a counter that records the command and
// the first app frame that sent it, in front of the real Upstash REST client
// talking to a private redis-server, so the production Lua runs unchanged.
const harness = vi.hoisted(() => ({
  client: null as unknown,
  record: null as
    | null
    | ((command: string, key: unknown, stack: string | undefined) => void),
}));
vi.mock("@/utils/redis", async () => {
  const { getRedisUsageMeter } = await import("@/utils/redis/usage-meter");
  const counted = new Proxy(
    {},
    {
      get: (_, property) => {
        const client = harness.client as Record<PropertyKey, unknown>;
        const value = client[property];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (typeof property === "string")
            harness.record?.(property, args[0], new Error("caller").stack);
          return (value as (...a: unknown[]) => unknown).apply(client, args);
        };
      },
    },
  );
  return { redis: getRedisUsageMeter().wrap(counted) };
});

const REDIS_SERVER = "/usr/bin/redis-server";
const TOKEN = "enumeration-redis-test-token";
const ACCOUNT = "account-1";
const logger = createScopedLogger("enumeration-redis-commands-test");

type Command = { command: string; feature: string; caller: string };
const requestCommands = new AsyncLocalStorage<Command[]>();

let server: ChildProcess | null = null;
let redis: Redis | null = null;
let http: Awaited<ReturnType<typeof createRedisHttpServer>> | null = null;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "Redis commands per enumeration request",
  { timeout: 60_000 },
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
      harness.client = new HttpRedis({ url: http.url, token: TOKEN });
      harness.record = (command, key, stack) => {
        requestCommands.getStore()?.push({
          command,
          feature: featureOf(command, key),
          caller: callerOf(stack),
        });
      };
    });
    beforeEach(async () => {
      await redis!.flushdb();
      resetGmailQuotaInstanceState();
      resetGmailInflightState();
    });
    afterAll(async () => {
      await http?.close();
      redis?.disconnect();
      server?.kill();
      vi.unstubAllGlobals();
    });

    it("keeps each page of a first sync and its backfill within its commands", async () => {
      const { enumerate } = await startEngine();
      const pages: Awaited<ReturnType<typeof enumerate>>[] = [];
      // The primary scan runs to its end, which lets the backfill start.
      for (const [scope, limit] of [
        ["primary", 10],
        ["history", 4],
      ] as const) {
        let page: string | null = await enumerate.begin(scope);
        for (let n = 0; n < limit && page; n++) {
          const result = await enumerate(page);
          pages.push(result);
          page = result.nextPage;
        }
      }
      if (process.env.REDIS_COMMANDS_REPORT)
        writeFileSync(
          process.env.REDIS_COMMANDS_REPORT,
          JSON.stringify(pages.map(summarize), null, 1),
        );
      expect(pages.map((page) => page.status)).toEqual(pages.map(() => "ok"));
      // Real time and the production Lua, so a page varies by a command or
      // two. These seven pages took 92 commands before admissions said what
      // the next batch would be told, and 73 to 75 since.
      const total = pages.reduce((sum, page) => sum + page.commands.length, 0);
      expect(total).toBeLessThanOrEqual(80);
    });
  },
);

async function startEngine() {
  const gmail = createFakeGmail({
    unitsPerMinute: 15_000,
    latencyMs: Number(process.env.GMAIL_LATENCY_MS ?? 100),
    recentCount: 50,
  });
  const realFetch = globalThis.fetch;
  const routed = (input: unknown, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(http!.url)
      ? realFetch(input as RequestInfo, init)
      : gmail.fetch(input, init);
  vi.stubGlobal("fetch", routed);
  const client = await getGmailClientWithRefresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    emailAccountId: ACCOUNT,
    logger,
  });
  const auth = client.context._options.auth as InstanceType<
    typeof gmailAuth.OAuth2
  >;
  auth.transporter.defaults.fetchImplementation = routed as typeof fetch;
  const provider = new GmailProvider(client, logger, ACCOUNT);
  const source = createEmailProviderMailboxSource({
    provider,
    accountId: ACCOUNT,
    logger,
  });
  const session = { accountId: ACCOUNT, generation: "gen-a" };
  const context = {
    session,
    requestId: "r",
    signal: new AbortController().signal,
  };
  const asRequest = async <T>(source: string, run: () => Promise<T>) => {
    const commands: Command[] = [];
    const metrics = createRequestMetrics();
    const value = await requestCommands.run(commands, () =>
      runWithRequestMetrics(metrics, () =>
        runWithAuditContext({ source, emailAccountId: ACCOUNT }, run),
      ),
    );
    return { value, commands, redisCalls: metrics.redis.calls };
  };
  const enumerate = Object.assign(
    async (page: string) => {
      const { value, commands, redisCalls } = await asRequest(
        "mail/v1/enumeration",
        () =>
          source.enumerate({
            ...context,
            bootstrapId: "mailbox",
            page,
            pageSize: 50,
          }),
      );
      return {
        status: value.status,
        scope: (JSON.parse(page) as { scopeId?: string }).scopeId,
        messages: value.status === "ok" ? value.value.changes.length : 0,
        nextPage: value.status === "ok" ? value.value.nextPage : null,
        commands,
        redisCalls,
      };
    },
    {
      async begin(scope: "primary" | "history") {
        const { value } = await asRequest("mail/v1/bootstrap", () =>
          source.beginBootstrap({
            ...context,
            scope: { id: scope, kind: "account", folderId: null },
            afterMs: null,
          }),
        );
        if (value.status !== "ok") throw new Error("bootstrap failed");
        return value.value.enumerationToken;
      },
    },
  );
  return { enumerate, gmail };
}

function summarize(page: {
  scope?: string;
  messages: number;
  commands: Command[];
  redisCalls: number;
}) {
  const byCaller = new Map<string, number>();
  for (const command of page.commands) {
    const key = `${command.caller} ${command.command} ${command.feature}`;
    byCaller.set(key, (byCaller.get(key) ?? 0) + 1);
  }
  return {
    scope: page.scope,
    messages: page.messages,
    commands: page.commands.length,
    redisCalls: page.redisCalls,
    byCaller: [...byCaller.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function featureOf(command: string, key: unknown) {
  const value = command.startsWith("eval") ? undefined : key;
  if (typeof value !== "string") return command;
  return value.split(":").slice(0, 2).join(":");
}

// The first frame in app code outside the Redis wrappers and this file.
function callerOf(stack: string | undefined) {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = line.match(
      /at (?:async )?(\S+) \(.*apps\/web\/(.+?):\d+:\d+\)/,
    );
    if (!match) continue;
    const [, fn, file] = match;
    if (
      file!.startsWith("__tests__/") ||
      file!.startsWith("utils/redis/usage-meter") ||
      file!.includes("node_modules")
    )
      continue;
    return `${file}:${fn}`;
  }
  return "unknown";
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
