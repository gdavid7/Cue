import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createCue, handler } from "../src/server.ts";

test("HTTP API: home, thread, approve, static UI", async () => {
  const cue = createCue({ CUE_BRAIN: "heuristic", CUE_ACTION_DELAY_MS: "0" });
  await cue.sync();
  const server = createServer(handler(cue)).listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const home = await (await fetch(`${base}/api/home`)).json();
    assert.equal(home.brain, "heuristic");
    assert.ok(home.lanes.needs_you.length > 0);

    const t = await (await fetch(`${base}/api/threads/thr_gt_soccer`)).json();
    const add = t.actions.find((a: any) => a.kind === "add_to_calendar");
    const res = await fetch(`${base}/api/actions/${add.id}/approve`, { method: "POST", body: "{}" });
    assert.equal((await res.json()).status, "done");

    const again = await fetch(`${base}/api/actions/${add.id}/approve`, { method: "POST", body: "{}" });
    assert.equal(again.status, 400);

    assert.equal((await fetch(`${base}/api/threads/nope`)).status, 404);
    assert.match(await (await fetch(`${base}/`)).text(), /<title>Cue<\/title>/);
  } finally {
    server.close();
  }
});
