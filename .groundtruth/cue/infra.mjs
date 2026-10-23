// Groundtruth's own throwaway Postgres and Redis, in Docker containers named groundtruth-cue-*. They never share
// a port or a volume with the dev database (docker-compose.dev.yml), so reset can only wipe Groundtruth's data.
import { execFileSync, spawn } from "node:child_process";
import { PORTS } from "./env.mjs";

const NETWORK = "groundtruth-cue";
const CONTAINERS = [
  {
    name: "groundtruth-cue-pg",
    // mirror.gcr.io: Docker Hub rate-limits anonymous pulls of postgres in cloud containers.
    args: ["-e", "POSTGRES_PASSWORD=postgres", "-p", `127.0.0.1:${PORTS.postgres}:5432`, "mirror.gcr.io/library/postgres:16"],
  },
  { name: "groundtruth-cue-redis", args: ["redis:7"] },
  {
    name: "groundtruth-cue-srh",
    args: [
      "-e", "SRH_MODE=env",
      "-e", "SRH_TOKEN=groundtruth-token",
      "-e", "SRH_CONNECTION_STRING=redis://groundtruth-cue-redis:6379",
      "-p", `127.0.0.1:${PORTS.redisHttp}:80`,
      "hiett/serverless-redis-http:latest",
    ],
  },
];

export async function ensureInfra() {
  await ensureDocker();
  if (!ok("docker", ["network", "inspect", NETWORK])) docker("network", "create", NETWORK);
  for (const c of CONTAINERS) {
    const state = out("docker", ["inspect", "-f", "{{.State.Running}}", c.name]);
    if (state === "true") continue;
    if (state === "false") docker("start", c.name);
    else docker("run", "-d", "--name", c.name, "--network", NETWORK, "--restart", "no", ...c.args);
  }
  await waitFor("Postgres", () => ok("docker", ["exec", "groundtruth-cue-pg", "pg_isready", "-U", "postgres"]));
  await waitFor("Redis HTTP", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORTS.redisHttp}/`)).status < 500; } catch { return false; }
  });
}

export function flushRedis() {
  docker("exec", "groundtruth-cue-redis", "redis-cli", "FLUSHALL");
}

// A cloud container restart stops the Docker daemon; start it again rather than fail.
async function ensureDocker() {
  if (ok("docker", ["info"])) return;
  spawn("dockerd", [], { detached: true, stdio: "ignore" }).unref();
  await waitFor("Docker", () => ok("docker", ["info"]));
}

function docker(...args) {
  execFileSync("docker", args, { stdio: ["ignore", "ignore", "inherit"] });
}
function ok(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}
function out(cmd, args) {
  try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}
async function waitFor(name, check, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not come up within ${timeoutMs / 1000}s`);
}
