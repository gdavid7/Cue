// `reset` for Groundtruth's copy of Cue: back to a fresh, signed-out Cue with the seeded fake Gmail mailbox.
// Safe while the app runs. It only ever touches Groundtruth's own containers and emulators (see infra.mjs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./env.mjs";
import { ensureInfra, flushRedis } from "./infra.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../apps/web");
const env = cleanEnv();

await ensureInfra();
// Drops and recreates Groundtruth's database only: DATABASE_URL points at the groundtruth-cue-pg container.
execFileSync("pnpm", ["exec", "prisma", "migrate", "reset", "--force"], { cwd: webDir, env, stdio: "inherit" });
flushRedis();

// The emulators exist only while the app runs (stack.mjs); before the first start there's nothing to reset.
// Ask the running stack to reset them and wait until it says they're back on their seed.
const pidFile = path.join(here, ".stack.pid");
const stackPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null;
if (stackPid && isAlive(stackPid)) {
  const id = `${process.pid}-${Date.now()}`;
  const done = path.join(here, ".stack.reset-done");
  fs.writeFileSync(path.join(here, ".stack.reset-request"), id);
  process.kill(stackPid, "SIGUSR2");
  const until = Date.now() + 150_000;
  while (!(fs.existsSync(done) && fs.readFileSync(done, "utf8") === id)) {
    if (Date.now() > until) throw new Error("the running app didn't finish resetting its emulators within 150 s");
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log("reset: database, Redis and fake mailboxes are back to their seeded state");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
