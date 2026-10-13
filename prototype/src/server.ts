// HTTP server: a small JSON API plus the static web UI. No framework needed.
//
//   GET  /api/home                  four lanes + account/rules/metrics summary
//   GET  /api/threads/:id           thread, analysis, context, actions
//   POST /api/actions/:id/approve   { body?: string }  (edited draft)
//   POST /api/actions/:id/dismiss
//   POST /api/actions/:id/undo
//   POST /api/rules/:id             { enabled: boolean }

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brain } from "./agent/brain.ts";
import { ClaudeBrain } from "./agent/claude.ts";
import { Cue } from "./engine.ts";
import { demoConnectors } from "./ingest/connectors.ts";
import { DEMO_NOW, demoUser, topicSeeds } from "./ingest/fixtures.ts";
import type { Account } from "./core/types.ts";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export function createCue(env = process.env): Cue {
  const wantClaude = env.CUE_BRAIN ? env.CUE_BRAIN === "claude" : !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const brain: Brain | undefined = wantClaude
    ? new ClaudeBrain({ model: env.CUE_MODEL, effort: (env.CUE_EFFORT as "low" | "medium" | "high" | undefined) ?? "medium" })
    : undefined;
  return new Cue({
    userName: demoUser.name,
    accounts: demoUser.accounts as unknown as Account[],
    family: [...demoUser.family],
    connectors: demoConnectors(),
    topics: topicSeeds,
    tz: env.CUE_TZ ?? "America/Los_Angeles",
    // The demo data is anchored to a fixed "today"; set CUE_LIVE_CLOCK=1 to use the real time.
    now: env.CUE_LIVE_CLOCK ? undefined : () => DEMO_NOW,
    brain,
    actionDelayMs: Number(env.CUE_ACTION_DELAY_MS ?? 2500),
  });
}

export function handler(cue: Cue) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "api") {
        const body = req.method === "POST" ? await readJson(req) : {};
        if (req.method === "GET" && parts[1] === "home") return json(res, 200, { lanes: cue.home(), ...cue.summary() });
        if (req.method === "GET" && parts[1] === "threads" && parts[2]) {
          const t = cue.thread(decodeURIComponent(parts[2]), { countView: true });
          return t ? json(res, 200, t) : json(res, 404, { error: "No such thread" });
        }
        if (req.method === "POST" && parts[1] === "actions" && parts[2]) {
          const id = decodeURIComponent(parts[2]);
          if (parts[3] === "approve") return json(res, 200, cue.approve(id, { body: typeof body.body === "string" ? body.body : undefined }));
          if (parts[3] === "dismiss") return json(res, 200, cue.dismiss(id));
          if (parts[3] === "undo") return json(res, 200, cue.undo(id));
        }
        if (req.method === "POST" && parts[1] === "rules" && parts[2]) {
          cue.setRule(decodeURIComponent(parts[2]), !!body.enabled);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found" });
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  };
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  if (rel.startsWith("..")) return json(res, 403, { error: "Forbidden" });
  try {
    const file = await readFile(join(WEB_ROOT, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cue = createCue();
  await cue.sync();
  const port = Number(process.env.PORT ?? 3000);
  createServer(handler(cue)).listen(port, () => {
    console.log(`Cue running at http://localhost:${port}  (brain: ${cue.summary().brain})`);
  });
}
