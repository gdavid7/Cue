import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import { Client } from "pg";
import Redis from "ioredis";
import { createComposioEmulator } from "../__tests__/emulators/composio";
import { createExaEmulator } from "../__tests__/emulators/exa";
import { createLlmEmulator } from "../__tests__/emulators/llm";
import { createStripeEmulator } from "../__tests__/emulators/stripe";
import {
  buildCueDemoCalendarEvents,
  buildCueDemoConnectorData,
  buildCueDemoInbox,
  buildCueDemoInsights,
  buildCueDemoWorkCalendarEvents,
  buildCueDemoWorkInbox,
  cueDemoChat,
  cueDemoReplySuggestions,
  cueDemoSearchAnswer,
  cueDemoThreadBriefs,
} from "../__tests__/fixtures/inboxes/cue-demo-inbox";
import {
  buildCueDemoWebData,
  cueDemoWebReply,
} from "../__tests__/fixtures/inboxes/cue-demo-web";
import { escapeHtml } from "../utils/string";
import { type EmulateSeedOptions, writeEmulateSeed } from "./emulate-seed";
import { createLocalEnvironment } from "./local-dev/environment";
import { acquireLocalLock } from "./local-dev/lock";
import { createProcessManager } from "./local-dev/processes";
import { createRedisHttpServer } from "./local-dev/redis-http";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = resolve(APP_DIR, "../..");
const DATA_DIR = resolve(ROOT_DIR, ".context/local-dev");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const exec = promisify(execFile);
const allocatedPorts = new Set<number>();

// Cue's demo inbox (David Lin) is the default. Set CUE_DEMO_INBOX=inbox-zero
// for Inbox Zero's original SaaS-founder demo.
const USE_CUE_DEMO = process.env.CUE_DEMO_INBOX !== "inbox-zero";
const DEMO_GOOGLE_EMAIL = "david.lin@ucsd.edu";
// David's work mailbox, an Outlook account he adds next to the school Gmail.
const DEMO_MICROSOFT_EMAIL = "david@brightline.io";
// A fixed emulator token for clearing the Outlook emulator's sample data before
// anyone signs in (the emulator forgets OAuth tokens it issued when it stops).
const DEMO_OUTLOOK_TOKEN = "cue-local-dev-outlook-token";
const EMPTY_INSIGHT = {
  action: "none",
  task: "",
  date: "",
  dateRole: "none",
  fact: "",
  factLabel: "",
};
// Without a real Composio key, the demo's connected apps come from an emulator.
const USE_COMPOSIO_EMULATOR = USE_CUE_DEMO && !process.env.COMPOSIO_API_KEY;
// Likewise the public web pages and searches, without a real Exa key.
const USE_EXA_EMULATOR = USE_CUE_DEMO && !process.env.EXA_API_KEY;
// Enough ids for every related item that can come before a web page.
const MAX_SOURCE_IDS = 12;

main().catch((error) => {
  console.error(
    `[local] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "3000" },
      backend: { type: "string", default: "auto" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm local:start [--port 3000] [--backend auto|native|docker]\n\nRequires Node.js 24, pnpm, and either Docker Compose or native PostgreSQL and Redis.\nOn macOS: brew install postgresql@16 redis\nData is preserved in .context/local-dev or the checkout's Docker volume.\nPress Ctrl-C to stop the app and the services started by this command.",
    );
    return;
  }
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Use Node.js 24, matching package.json engines.");
  if (process.platform === "win32")
    throw new Error(
      "Local development currently supports macOS and Linux. On Windows, run this command inside WSL.",
    );
  const appPort = Number(values.port);
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65_535)
    throw new Error("--port must be an integer between 1 and 65535");
  if (!["auto", "native", "docker"].includes(values.backend))
    throw new Error("--backend must be auto, native, or docker");
  await assertAppPortFree(appPort);
  allocatedPorts.add(appPort);

  const native = Object.fromEntries(
    ["initdb", "postgres", "redis-server"].map((name) => [
      name,
      findExecutable(name),
    ]),
  );
  let backend = values.backend;
  if (backend === "auto")
    backend = Object.values(native).every(Boolean) ? "native" : "docker";
  if (backend === "native" && !Object.values(native).every(Boolean))
    throw new Error(
      "Native development requires initdb, postgres, and redis-server. On macOS: brew install postgresql@16 redis. Alternatively install Docker and use --backend docker.",
    );
  if (backend === "docker") {
    try {
      await exec("docker", ["compose", "version"], { timeout: 15_000 });
      await exec("docker", ["info"], { timeout: 15_000 });
    } catch {
      throw new Error(
        "Start Docker Desktop with Compose installed, or install PostgreSQL and Redis and use --backend native. On macOS: brew install postgresql@16 redis.",
      );
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const unlock = await acquireLocalLock(
    join(DATA_DIR, "launcher.pid"),
    appPort,
  );
  const cleanup: { close: () => Promise<unknown>; timeout?: number }[] = [];
  let manager: ReturnType<typeof createProcessManager> | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    manager?.abort(new Error("Stopping local development"));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const secretsPath = join(DATA_DIR, "secrets.json");
    if (!existsSync(secretsPath)) {
      writeFileSync(
        secretsPath,
        JSON.stringify({
          database: randomBytes(24).toString("hex"),
          auth: randomBytes(32).toString("hex"),
          encryption: randomBytes(32).toString("hex"),
          redis: randomBytes(32).toString("hex"),
        }),
        { mode: 0o600, flag: "wx" },
      );
    }
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    const [
      databasePort,
      redisPort,
      redisHttpPort,
      googlePort,
      microsoftPort,
      llmPort,
      stripePort,
      emailPort,
      composioPort,
      exaPort,
    ] = await Promise.all(Array.from({ length: 10 }, () => availablePort()));
    const env = createLocalEnvironment({
      appPort,
      databasePort,
      redisPort,
      redisHttpPort,
      googlePort,
      microsoftPort,
      llmPort,
      stripePort,
      secrets,
      inherited: process.env,
    });
    // Give this launcher its own Next output and lock, separate from pnpm dev and Playwright.
    env.PLAYWRIGHT_RUN_ID = "local-dev";
    env.RESEND_API_KEY = "local-email-key";
    env.RESEND_BASE_URL = `http://127.0.0.1:${emailPort}`;
    env.RESEND_FROM_EMAIL = "Inbox Zero <signin@example.com>";
    env.RESEND_AUDIENCE_ID = "playwright-audience";
    if (USE_COMPOSIO_EMULATOR) {
      env.COMPOSIO_API_KEY = "emulator-composio-key";
      env.COMPOSIO_API_URL = `http://127.0.0.1:${composioPort}/api/v3`;
    }
    if (USE_EXA_EMULATOR) {
      env.EXA_API_KEY = "emulator-exa-key";
      env.EXA_API_URL = `http://127.0.0.1:${exaPort}`;
    }
    manager = createProcessManager(APP_DIR, env);
    const processes = manager;

    if (backend === "native") {
      const postgresDir = join(DATA_DIR, "postgres");
      const passwordFile = join(DATA_DIR, "postgres-password");
      if (!existsSync(join(postgresDir, "PG_VERSION"))) {
        writeFileSync(passwordFile, secrets.database, { mode: 0o600 });
        try {
          await processes.run("PostgreSQL initialization", native.initdb!, [
            "-D",
            postgresDir,
            "-U",
            "postgres",
            "--auth=scram-sha-256",
            "--pwfile",
            passwordFile,
          ]);
        } finally {
          unlinkSync(passwordFile);
        }
      }
      processes.start("PostgreSQL", native.postgres!, [
        "-D",
        postgresDir,
        "-h",
        "127.0.0.1",
        "-p",
        String(databasePort),
      ]);
      processes.start("Redis", native["redis-server"]!, [
        "--bind",
        "127.0.0.1",
        "--port",
        String(redisPort),
        "--save",
        "",
        "--appendonly",
        "no",
      ]);
    } else {
      const project = `inboxzero-local-${createHash("sha256").update(ROOT_DIR).digest("hex").slice(0, 12)}`;
      const args = [
        "compose",
        "-p",
        project,
        "-f",
        join(ROOT_DIR, "docker-compose.local.yml"),
      ];
      const dockerEnv = {
        ...env,
        LOCAL_POSTGRES_PASSWORD: secrets.database,
        LOCAL_POSTGRES_PORT: String(databasePort),
        LOCAL_REDIS_PORT: String(redisPort),
      };
      cleanup.push({
        close: () =>
          exec("docker", [...args, "down"], {
            env: dockerEnv,
            timeout: 60_000,
          }),
        timeout: 65_000,
      });
      await exec("docker", [...args, "up", "-d"], {
        env: dockerEnv,
        timeout: 240_000,
        signal: processes.signal,
      });
    }

    const adminUrl = new URL(env.DATABASE_URL);
    adminUrl.pathname = "/postgres";
    await processes.ready("PostgreSQL", async () => {
      const client = new Client({
        connectionString: adminUrl.href,
        connectionTimeoutMillis: 2000,
        query_timeout: 5000,
      });
      try {
        await client.connect();
        await client.query("SELECT 1");
      } finally {
        await client.end();
      }
    });
    const client = new Client({
      connectionString: adminUrl.href,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    await client.connect();
    try {
      const database = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = 'inboxzero_local'",
      );
      if (!database.rowCount)
        await client.query("CREATE DATABASE inboxzero_local");
    } finally {
      await client.end();
    }
    await processes.run("Database migrations", PNPM, [
      "exec",
      "prisma",
      "migrate",
      "deploy",
    ]);
    await configureDemoOnboarding(env.DATABASE_URL);
    await configureDemoAccount(env.DATABASE_URL, {
      enabled: USE_CUE_DEMO,
      connectApps: USE_COMPOSIO_EMULATOR,
    });

    const redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 5000,
      retryStrategy: () => null,
    });
    cleanup.push({ close: async () => redis.disconnect() });
    await redis.connect();
    await redis.ping();
    const redisHttp = await createRedisHttpServer({
      redis,
      token: secrets.redis,
      port: redisHttpPort,
    });
    cleanup.push({ close: redisHttp.close });
    await processes.ready("Redis HTTP", () =>
      checkUrl(`${redisHttp.url}/health`, {
        authorization: `Bearer ${secrets.redis}`,
      }),
    );

    const seedPath = join(DATA_DIR, "seed.json");
    const demoSeed = USE_CUE_DEMO ? cueDemoSeedOptions() : undefined;
    await writeEmulateSeed(seedPath, env.NEXT_PUBLIC_BASE_URL, false, demoSeed);
    for (const [service, port] of [
      ["google", googlePort],
      ["microsoft", microsoftPort],
    ] as const) {
      processes.start(`${service} emulator`, PNPM, [
        "exec",
        "emulate",
        "start",
        "--service",
        service,
        "--seed",
        seedPath,
        "--port",
        String(port),
      ]);
      await processes.ready(`${service} emulator`, () =>
        checkUrl(`http://localhost:${port}/.well-known/openid-configuration`),
      );
    }
    if (demoSeed) {
      await removeOutlookEmulatorSamples(
        `http://localhost:${microsoftPort}`,
        demoSeed,
      ).catch((error) =>
        console.warn("[local] Outlook sample mail not removed", error),
      );
    }
    const llm = await createLlmEmulator({ port: llmPort });
    cleanup.push({ close: llm.close });
    if (USE_CUE_DEMO) {
      for (const brief of cueDemoThreadBriefs) {
        // Matches the escaped subject the brief prompt sends (see stringifyEmail).
        llm.reply({
          match: `<subject>${escapeHtml(brief.subject)}</subject>`,
          object: { summary: brief.summary, keyPoints: brief.keyPoints },
        });
      }
      // Registered first, so the mail-specific replies below win where the
      // answer's matching text also appears in an email.
      llm.reply({
        match: cueDemoChat.question,
        toolCall: { name: "searchContext", arguments: cueDemoChat.search },
      });
      llm.reply({ match: cueDemoChat.answerAfter, text: cueDemoChat.answer });
      // Mail without a scripted note gets none, not the emulator's placeholder.
      llm.reply({
        match: "You add a one-line note under an email",
        object: EMPTY_INSIGHT,
      });
      for (const insight of buildCueDemoInsights()) {
        // The inbox insight prompt opens with the email's own subject line.
        llm.reply({
          match: `<email>\nSubject: ${escapeHtml(insight.subject)}\n`,
          object: insight.object,
        });
      }
      for (const suggestion of cueDemoReplySuggestions) {
        // The thread's own first message, which no other thread's prompt has.
        llm.reply({
          match: `<source id="m1" kind="message">\nSubject: ${escapeHtml(suggestion.subject)}`,
          object: suggestion.object,
        });
      }
      // A search that only looks for mail gets no answer; the demo question,
      // registered after, gets one. Both after the chat's replies, which also
      // match the question.
      llm.reply({
        match: "You answer a search the user typed into their mailbox",
        object: cueDemoSearchAnswer.none,
      });
      llm.reply({
        match: `<question>${escapeHtml(cueDemoSearchAnswer.question)}</question>`,
        object: cueDemoSearchAnswer.object,
      });
      // Registered last, so with the SFO page among the sources it wins over
      // the abstention for Mom's thread.
      const { page } = cueDemoWebReply;
      for (let n = 1; n <= MAX_SOURCE_IDS; n++) {
        llm.reply({
          match: `<source id="c${n}" kind="web">\n${escapeHtml(`Web page: ${page.title} (${new URL(page.url).hostname.replace(/^www\./, "")})`)}`,
          object: cueDemoWebReply.object(`c${n}`),
        });
      }
    }
    const stripe = await createStripeEmulator({
      port: stripePort,
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      webhookUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/stripe/webhook`,
    });
    cleanup.push({ close: stripe.close });
    if (USE_COMPOSIO_EMULATOR) {
      const composio = await createComposioEmulator({
        port: composioPort,
        apiKey: env.COMPOSIO_API_KEY,
        ...buildCueDemoConnectorData(),
      });
      cleanup.push({ close: composio.close });
    }
    if (USE_EXA_EMULATOR) {
      const exa = await createExaEmulator({
        port: exaPort,
        apiKey: env.EXA_API_KEY,
        ...buildCueDemoWebData(),
      });
      cleanup.push({ close: exa.close });
    }
    processes.start("Email emulator", process.execPath, [
      "__tests__/playwright/email-server.mjs",
      String(emailPort),
    ]);
    await processes.ready("Email emulator", () =>
      checkUrl(env.RESEND_BASE_URL),
    );
    writeFileSync(
      join(DATA_DIR, "runtime.json"),
      `${JSON.stringify(env, null, 2)}\n`,
      { mode: 0o600 },
    );
    processes.start("Next.js", PNPM, [
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ]);
    await processes.ready(
      "Next.js",
      () => checkUrl(`${env.NEXT_PUBLIC_BASE_URL}/api/auth/ok`),
      240_000,
    );
    const signIn = USE_CUE_DEMO
      ? `[local] Sign in with Google: ${DEMO_GOOGLE_EMAIL} (school Gmail)\n[local] Then add the work Outlook: account switcher > Add another account > Add Microsoft > ${DEMO_MICROSOFT_EMAIL}. Both show in All inboxes.`
      : "[local] Sign in with Google: developer@example.com\n[local] Or Microsoft: developer@outlook.test";
    console.log(
      `\n[local] Ready: ${env.NEXT_PUBLIC_BASE_URL}/mail\n${signIn}\n[local] Mail, billing, email delivery, and AI use local emulators. AI responses are canned.\n[local] Data survives restarts. Press Ctrl-C to stop.\n`,
    );
    await delay(2 ** 31 - 1, undefined, { signal: processes.signal });
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    console.log("[local] Stopping services");
    for (const { close, timeout = 10_000 } of cleanup.reverse()) {
      const deadline = new AbortController();
      try {
        await Promise.race([
          close(),
          delay(timeout, undefined, { signal: deadline.signal }).then(() => {
            throw new Error("Cleanup timed out");
          }),
        ]);
      } catch (error) {
        console.error("[local] Cleanup failed", error);
        process.exitCode = 1;
      } finally {
        deadline.abort();
      }
    }
    try {
      await manager?.stop();
    } finally {
      try {
        await unlock();
      } catch (error) {
        console.error("[local] Could not release launcher lock", error);
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  }
}

async function configureDemoOnboarding(databaseUrl: string) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  await client.connect();
  try {
    // OAuth must create users and accounts together; pre-created users cannot
    // sign in through providers that intentionally forbid linking by email.
    await client.query(`
      CREATE OR REPLACE FUNCTION local_dev_complete_onboarding() RETURNS trigger AS $$
      BEGIN
        NEW."completedOnboardingAt" := COALESCE(NEW."completedOnboardingAt", NOW());
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS local_dev_onboarding ON "User";
      CREATE TRIGGER local_dev_onboarding BEFORE INSERT ON "User"
      FOR EACH ROW WHEN (NEW.email IN ('developer@example.com', '${DEMO_GOOGLE_EMAIL}', 'developer@outlook.test', '${DEMO_MICROSOFT_EMAIL}'))
      EXECUTE FUNCTION local_dev_complete_onboarding();
    `);
  } finally {
    await client.end();
  }
}

function cueDemoSeedOptions(): EmulateSeedOptions {
  const now = new Date();
  return {
    fixture: buildCueDemoInbox(now),
    googleEmail: DEMO_GOOGLE_EMAIL,
    googleName: "David Lin",
    calendarEvents: buildCueDemoCalendarEvents(DEMO_GOOGLE_EMAIL, now),
    microsoftEmail: DEMO_MICROSOFT_EMAIL,
    microsoftName: "David Lin",
    microsoftFixture: buildCueDemoWorkInbox(now),
    microsoftCalendarEvents: buildCueDemoWorkCalendarEvents(
      DEMO_MICROSOFT_EMAIL,
      now,
    ),
    tokens: {
      [DEMO_OUTLOOK_TOKEN]: {
        login: DEMO_MICROSOFT_EMAIL,
        scopes: [],
      },
    },
  };
}

/**
 * The Microsoft emulator gives every mailbox sample mail and meetings. The
 * demo's work mailbox should hold only David's, so this deletes the rest
 * (deleted mail lands in Deleted Items; the emulator has no hard delete).
 */
async function removeOutlookEmulatorSamples(
  baseUrl: string,
  seed: EmulateSeedOptions,
) {
  const keep = new Set([
    ...(seed.microsoftFixture?.threads ?? []).flatMap((t) =>
      t.messages.map((m) => m.id),
    ),
    ...(seed.microsoftCalendarEvents ?? []).map((e) => e.id),
  ]);
  const graph = async (path: string, method = "GET") => {
    const response = await fetch(`${baseUrl}/v1.0/me${path}`, {
      method,
      headers: { authorization: `Bearer ${DEMO_OUTLOOK_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status} from Outlook emulator ${path}`);
    return method === "GET"
      ? ((await response.json()) as { value: { id: string }[] })
      : undefined;
  };

  const messages = await graph("/messages?$top=100");
  const calendars = await graph("/calendars");
  const events = (
    await Promise.all(
      (calendars?.value ?? []).map((c) =>
        graph(`/calendars/${encodeURIComponent(c.id)}/events?$top=100`),
      ),
    )
  ).flatMap((page) => page?.value ?? []);
  for (const { id } of messages?.value ?? [])
    if (!keep.has(id))
      await graph(`/messages/${encodeURIComponent(id)}`, "DELETE");
  for (const { id } of events)
    if (!keep.has(id))
      await graph(`/events/${encodeURIComponent(id)}`, "DELETE");
}

/**
 * With `connectApps`, connects Google Drive and Canvas to the demo Gmail
 * account as soon as it exists, and to an account that already does; the
 * Composio emulator answers for them, and the app shares them with the
 * person's other accounts. Calendars connect the way they do for anyone:
 * signing in asks for calendar access and syncs the emulator's calendars.
 * When the Cue demo is off, removes the trigger and the connections, whose
 * credentials would be dead.
 */
async function configureDemoAccount(
  databaseUrl: string,
  { enabled, connectApps }: { enabled: boolean; connectApps: boolean },
) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  await client.connect();
  try {
    // Before sign-in connected calendars, the demo faked connections with
    // fixed tokens the emulator no longer accepts.
    await client.query(`
      DROP TRIGGER IF EXISTS cue_local_dev_calendar ON "EmailAccount";
      DROP TRIGGER IF EXISTS cue_local_dev_outlook_calendar ON "EmailAccount";
      DROP FUNCTION IF EXISTS cue_local_dev_connect_calendar_trigger();
      DROP FUNCTION IF EXISTS cue_local_dev_connect_calendar(text, text, text);
      DROP FUNCTION IF EXISTS cue_local_dev_connect_calendar(text, text, text, text);
      DELETE FROM "CalendarConnection" WHERE id LIKE '%-cue-demo-calendar';
    `);
    if (!enabled) {
      await client.query(`
        DROP TRIGGER IF EXISTS cue_local_dev_apps ON "EmailAccount";
        DROP FUNCTION IF EXISTS cue_local_dev_connect_apps_trigger();
        DROP FUNCTION IF EXISTS cue_local_dev_add_splits(text);
        DROP FUNCTION IF EXISTS cue_local_dev_connect_apps(text);
        DELETE FROM "McpConnection" WHERE id LIKE '%-cue-demo-app-%';
      `);
      return;
    }
    // A real Composio account has none of the connections the emulator faked.
    if (!connectApps) {
      await client.query(
        `DELETE FROM "McpConnection" WHERE id LIKE '%-cue-demo-app-%'`,
      );
    }

    await client.query(`
      -- The "Needs reply" and "Reading" tabs the first-run inbox card's opt-in
      -- creates (see addCueTabs): label filters over the inbox, which never
      -- move mail.

      -- The rows connecting an app through Composio would create; the Composio
      -- emulator treats every account as connected on its side.
      CREATE OR REPLACE FUNCTION cue_local_dev_connect_apps(account_id text)
      RETURNS void AS $$
      BEGIN
        INSERT INTO "McpIntegration" (id, "createdAt", "updatedAt", name)
        VALUES
          ('cue-demo-integration-googledrive', NOW(), NOW(), 'googledrive'),
          ('cue-demo-integration-canvas', NOW(), NOW(), 'canvas')
        ON CONFLICT (name) DO NOTHING;
        INSERT INTO "McpConnection" (id, "createdAt", "updatedAt", name, "isActive", "integrationId", "emailAccountId")
        SELECT account_id || '-cue-demo-app-' || i.name, NOW(), NOW(), i.name, true, i.id, account_id
        FROM "McpIntegration" i
        WHERE i.name IN ('googledrive', 'canvas')
        ON CONFLICT ("emailAccountId", "integrationId") DO NOTHING;
      END;
      $$ LANGUAGE plpgsql;

      -- Runs inside the sign-in transaction, so a schema change that breaks
      -- these inserts must not break signing in. Inbox tabs come from the
      -- first-run card, as for a real user.
      CREATE OR REPLACE FUNCTION cue_local_dev_connect_apps_trigger() RETURNS trigger AS $$
      BEGIN
        PERFORM cue_local_dev_connect_apps(NEW.id);
        RETURN NEW;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Cue demo apps not connected: %', SQLERRM;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS cue_local_dev_apps ON "EmailAccount";
    `);
    if (connectApps) {
      // Trigger definitions can't take bind parameters; the address is a
      // constant defined in this file.
      await client.query(`
        CREATE TRIGGER cue_local_dev_apps AFTER INSERT ON "EmailAccount"
        FOR EACH ROW WHEN (NEW.email = '${DEMO_GOOGLE_EMAIL}')
        EXECUTE FUNCTION cue_local_dev_connect_apps_trigger();
      `);
      await client.query(
        `SELECT cue_local_dev_connect_apps(id) FROM "EmailAccount" WHERE email = $1`,
        [DEMO_GOOGLE_EMAIL],
      );
    }
    // A database from before the Cue demo still calls the demo user "Developer".
    await client.query(
      `UPDATE "User" SET name = 'David Lin' WHERE email = $1 AND name = 'Developer'`,
      [DEMO_GOOGLE_EMAIL],
    );
    await client.query(
      `UPDATE "EmailAccount" SET name = 'David Lin' WHERE email = $1 AND name = 'Developer'`,
      [DEMO_GOOGLE_EMAIL],
    );
  } finally {
    await client.end();
  }
}

function findExecutable(name: string) {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
  ];
  return directories
    .map((directory) => join(directory, name))
    .find((path) => existsSync(path));
}

function availablePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Could not allocate a local port"));
      server.close(() => {
        if (allocatedPorts.has(address.port)) {
          availablePort().then(resolvePort, reject);
          return;
        }
        allocatedPorts.add(address.port);
        resolvePort(address.port);
      });
    });
  });
}

async function assertAppPortFree(port: number) {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is already in use. Stop that server or use pnpm local:start --port ${port + 1}.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
}

async function checkUrl(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  await response.body?.cancel();
}
