// `start` for Groundtruth's copy of Cue: one process that brings up the throwaway database, applies migrations,
// then runs exactly the servers CI's browser tests run (apps/web/playwright.config.mjs `webServer`): the fake
// email server, the Gmail emulator, the Stripe emulator, the AI emulator and `next start`.
//
// Each server runs in its own process group, and stopping means stopping that whole group: the configured
// commands go through `npx` and `pnpm exec`, which don't pass SIGTERM on, so killing only the wrapper would
// leave the real server holding its port. Groundtruth's stop (SIGTERM to this process) stops every group.
// SIGUSR2 is reset.mjs asking to clear the in-memory emulators, which have no reset route of their own: the
// Stripe emulator takes a "reset" line, and the email server and Gmail emulator are restarted from their seed
// (and Next.js with them; see RESTARTED_ON_RESET).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_ENV, cleanEnv, PORTS } from "./env.mjs";
import { ensureInfra } from "./infra.mjs";
import { startFrontProxy } from "./proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../apps/web");
const PID_FILE = path.join(here, ".stack.pid");
const RESET_REQUEST = path.join(here, ".stack.reset-request");
const RESET_DONE = path.join(here, ".stack.reset-done");
const GROUPS_FILE = path.join(here, ".stack.groups");
// Next.js too: a restarted Google emulator signs ID tokens with a new key under the same key id, and a
// running server keeps the old key set cached, so every sign-in after a reset would fail.
const RESTARTED_ON_RESET = ["Email emulator", "Google emulator", "Next.js"];

// Replace the whole environment before the config is read: it copies process.env into every server it starts.
const env = cleanEnv();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.chdir(webDir);

// A stack that was killed outright (SIGKILL, container restart) can't clean up; stop what it left first.
// A recorded id could have been reused after a container restart, so only groups still running in apps/web count.
for (const pgid of readGroups().filter(runsInWebDir)) await killGroup(pgid);
await ensureInfra();
execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { stdio: "inherit" });

const { default: config } = await import(pathToFileURL(path.join(webDir, "playwright.config.mjs")).href);
const children = new Map();
let stopping = false;

// Next.js listens behind the front proxy (proxy.mjs), which holds the app's port.
const nextServer = config.webServer.find((s) => s.name === "Next.js");
if (!nextServer?.command.includes(`--port ${PORTS.app}`)) throw new Error("Can't find the Next.js server's port in playwright.config.mjs");
nextServer.command = nextServer.command.replace(`--port ${PORTS.app}`, `--port ${PORTS.appServer}`);
nextServer.url = nextServer.url.replace(`:${PORTS.app}/`, `:${PORTS.appServer}/`);
const proxy = startFrontProxy({ port: PORTS.app, appPort: PORTS.appServer, googleUrl: APP_ENV.GOOGLE_BASE_URL });

for (const server of config.webServer) run(server);
fs.writeFileSync(PID_FILE, String(process.pid));

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
process.on("SIGUSR2", async () => {
  const request = fs.existsSync(RESET_REQUEST) ? fs.readFileSync(RESET_REQUEST, "utf8") : "";
  children.get("Stripe emulator")?.stdin?.write("reset\n");
  const restarting = config.webServer.filter((s) => RESTARTED_ON_RESET.includes(s.name));
  await Promise.all(restarting.map((s) => restart(s)));
  fs.writeFileSync(RESET_DONE, request);
});

async function restart(server) {
  const old = children.get(server.name);
  if (old) {
    old.restarting = true;
    await killGroup(old.pid);
  }
  run(server);
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try { if ((await fetch(server.url)).status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`${server.name} did not come back after reset`);
}

function run(server) {
  const child = spawn(server.command, {
    shell: true,
    detached: true,
    cwd: server.cwd,
    env: server.env ?? process.env,
    stdio: [server.name === "Stripe emulator" ? "pipe" : "ignore", "inherit", "inherit"],
  });
  children.set(server.name, child);
  writeGroups();
  child.on("exit", (code) => {
    if (stopping || child.restarting) return;
    console.error(`${server.name} exited (${code}); stopping the rest`);
    stop(1);
  });
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  fs.rmSync(PID_FILE, { force: true });
  proxy.close();
  await Promise.all([...children.values()].map((c) => killGroup(c.pid)));
  fs.rmSync(GROUPS_FILE, { force: true });
  process.exit(code);
}

// SIGTERM to the whole group, SIGKILL after 5 s, and resolve once no process of the group is left.
async function killGroup(pgid) {
  const alive = () => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  const killAt = Date.now() + 5000;
  while (alive()) {
    if (Date.now() > killAt) try { process.kill(-pgid, "SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

function writeGroups() {
  fs.writeFileSync(GROUPS_FILE, [...children.values()].map((c) => c.pid).join("\n"));
}
function readGroups() {
  try { return fs.readFileSync(GROUPS_FILE, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}
function runsInWebDir(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`) === webDir; } catch { return false; }
}
