import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeBrain } from "../src/agent/claude.ts";
import { demoCue } from "./helpers.ts";

/** A stand-in for the Anthropic client that records the request. */
function fakeClient(respond: (params: any) => any) {
  const calls: any[] = [];
  const client = { beta: { messages: { parse: async (params: any) => { calls.push(params); return respond(params); } } } };
  return { client: client as unknown as Anthropic, calls };
}

test("Claude's analysis replaces the heuristic wording, with safe request settings", async () => {
  const { client, calls } = fakeClient(() => ({
    stop_reason: "end_turn",
    parsed_output: {
      intent: "question",
      summary: "Mom wants to know which day you're flying in.",
      what_matters: ["You fly Wed Nov 25, landing PDX 5:58 PM."],
      replies: [{ label: "Wednesday", body: "Hi Mom! Wednesday the 25th, landing 5:58pm. Love, Alex" }],
    },
  }));
  const cue = await demoCue({ brain: new ClaudeBrain({ client }) });
  await new Promise((r) => setTimeout(r, 20)); // background refinement
  const t = cue.thread("thr_gt_mom")!;
  assert.equal(t.analysis.by, "claude");
  assert.equal(t.analysis.summary, "Mom wants to know which day you're flying in.");
  assert.equal(t.actions.find((a) => a.kind === "send_reply")!.params.body, "Hi Mom! Wednesday the 25th, landing 5:58pm. Love, Alex");

  const req = calls.find((c) => c.messages[0].content.includes("Thanksgiving!!"));
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.ok(!("tools" in req), "the writing layer has no tools");
  assert.match(req.messages[0].content, /<context found by Cue>[\s\S]*SFO to PDX/);
  // Noise is never sent to the model.
  assert.ok(!calls.some((c) => c.messages[0].content.includes("Fearless Flyer")));
});

test("falls back to heuristics on refusal or error", async () => {
  const { client } = fakeClient((p) => {
    if (p.messages[0].content.includes("Lease")) return { stop_reason: "refusal", parsed_output: null };
    throw new Error("network down");
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const cue = await demoCue({ brain: new ClaudeBrain({ client }) });
    await new Promise((r) => setTimeout(r, 20));
    const t = cue.thread("thr_gt_lease")!;
    assert.equal(t.analysis.by, "heuristic");
    assert.ok(t.analysis.whatMatters.length > 0);
  } finally {
    console.warn = warn;
  }
});
