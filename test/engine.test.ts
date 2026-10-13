import assert from "node:assert/strict";
import { test } from "node:test";
import { Cue } from "../src/engine.ts";
import { demoCue, laneOf } from "./helpers.ts";

test("home screen sorts the demo inbox into the four lanes", async () => {
  const cue = await demoCue();
  assert.equal(laneOf(cue, "thr_gt_lease"), "needs_you");
  assert.equal(laneOf(cue, "thr_gt_soccer"), "needs_you");
  assert.equal(laneOf(cue, "thr_gt_mom"), "needs_you");
  assert.equal(laneOf(cue, "thr_gt_fan"), "waiting");
  assert.equal(laneOf(cue, "thr_gt_sam"), "waiting");
  assert.equal(laneOf(cue, "thr_gt_tj"), "taken_care_of"); // newsletter filed
  assert.equal(laneOf(cue, "thr_ot_amazon"), "taken_care_of"); // receipt filed
  assert.equal(laneOf(cue, "thr_gt_pge"), "taken_care_of"); // bill reminder set by rule
  assert.equal(laneOf(cue, "thr_gt_school"), "taken_care_of"); // date added by rule
  // The most urgent decision is on top.
  assert.equal(cue.home().needs_you[0].threadId, "thr_gt_lease");
});

test("soccer: finds the signed form (not the blank one) and the same-day party", async () => {
  const t = (await demoCue()).thread("thr_gt_soccer")!;
  const titles = t.context.map((c) => c.title);
  assert.ok(titles.includes("Maya - Medical Release Form (signed).pdf"), titles.join(" | "));
  assert.ok(!titles.includes("Medical Release Form - blank.pdf"));
  assert.ok(titles.some((x) => x.startsWith("Leo's birthday party")));
  assert.ok(t.analysis.whatMatters.some((m) => /Leo's birthday party starts at 10:00 AM/.test(m)));
  const reply = t.actions.find((a) => a.kind === "send_reply")!;
  assert.equal((reply.params.attachments as { title: string }[])[0].title, "Maya - Medical Release Form (signed).pdf");
  assert.equal(reply.risk, "high");
});

test("soccer: the calendar invite from 'Coach Dana' is linked to Dana Kim with < 100% confidence", async () => {
  const t = (await demoCue()).thread("thr_gt_soccer")!;
  const practice = t.context.find((c) => c.title.startsWith("Hornets practice"))!;
  assert.ok(practice.confidence < 1 && practice.confidence >= 0.7);
  assert.equal(practice.path[0], "Dana Kim");
});

test("lease: compares the offer with the rent and cap in the lease PDF", async () => {
  const t = (await demoCue()).thread("thr_gt_lease")!;
  assert.ok(t.analysis.whatMatters.some((m) => m.includes("+$100 (4.9%)") && m.includes("within the 5% cap")), t.analysis.whatMatters.join("\n"));
  assert.ok(t.analysis.whatMatters.some((m) => m.startsWith("Confirm by Tue, Oct 20 (in 7 days)")));
  assert.deepEqual(t.actions.filter((a) => a.kind === "send_reply").map((a) => a.params.option), ["Accept", "Decline"]);
});

test("mom: the answer comes from a different inbox", async () => {
  const t = (await demoCue()).thread("thr_gt_mom")!;
  const flight = t.context.find((c) => c.title.includes("SFO to PDX"))!;
  assert.equal(flight.source?.accountId, "acct_outlook");
  assert.ok(t.analysis.whatMatters.some((m) => m.includes("Old inbox (Outlook)") && m.includes("Nov 25")));
  assert.match(String(t.actions[0].params.body), /^Hi Mom,[\s\S]*Love,\nAlex$/);
});

test("sending a reply moves the thread out of Needs you and records it", async () => {
  const cue = await demoCue();
  const reply = cue.thread("thr_gt_soccer")!.actions.find((a) => a.kind === "send_reply")!;
  cue.approve(reply.id, { body: "Hi Dana,\n\nYes! Form attached.\n\nThanks,\nAlex" });
  assert.equal(laneOf(cue, "thr_gt_soccer"), "taken_care_of");
  const t = cue.thread("thr_gt_soccer")!;
  assert.equal(t.messages.at(-1)!.body, "Hi Dana,\n\nYes! Form attached.\n\nThanks,\nAlex");
  assert.deepEqual(t.messages.at(-1)!.attachments, ["Maya - Medical Release Form (signed).pdf"]);
  assert.equal(t.actions.filter((a) => a.kind === "send_reply" && a.status === "proposed").length, 0); // other option withdrawn
  assert.match(cue.audit[0].text, /^Sent to Dana Kim with Maya - Medical Release Form/);
  assert.equal(cue.audit[0].by, "you");
  assert.throws(() => cue.undo(reply.id), /can't be unsent/);
});

test("a reply that asks a question moves the thread to Waiting", async () => {
  const cue = await demoCue();
  const reply = cue.thread("thr_gt_mom")!.actions[0];
  cue.approve(reply.id, { body: "Hi Mom, Wednesday! Can Dad still get me at 6?" });
  assert.equal(laneOf(cue, "thr_gt_mom"), "waiting");
});

test("low-risk actions can be undone", async () => {
  const cue = await demoCue();
  const add = cue.thread("thr_ot_dentist")!.actions.find((a) => a.kind === "add_to_calendar")!;
  cue.approve(add.id);
  const eventId = String(add.params.eventId);
  assert.ok(cue.graph.nodes.has(eventId));
  cue.undo(add.id);
  assert.ok(!cue.graph.nodes.has(eventId));
});

test("auto-filed mail can be un-filed", async () => {
  const cue = await demoCue();
  const archive = cue.thread("thr_gt_tj")!.actions[0];
  assert.equal(archive.autoRule, "file_noise");
  cue.undo(archive.id);
  assert.notEqual(laneOf(cue, "thr_gt_tj"), undefined);
  assert.equal(cue.thread("thr_gt_tj")!.actions[0].status, "undone");
});

test("autonomy rules can be switched off", async () => {
  const base = await demoCue();
  const cue = new Cue({ ...base.opts });
  for (const r of cue.rules) cue.setRule(r.id, false);
  await cue.sync();
  assert.equal(laneOf(cue, "thr_gt_pge"), "needs_you"); // no automatic reminder → needs you
  assert.equal(cue.audit.length, 0);
});

test("dismissing is recorded, and only proposed actions can be approved", async () => {
  const cue = await demoCue();
  const a = cue.thread("thr_gt_lease")!.actions.find((x) => x.params.option === "Decline")!;
  cue.dismiss(a.id);
  assert.equal(cue.audit[0].text, "Dismissed: Reply: Decline");
  assert.throws(() => cue.approve(a.id), /dismissed/);
  assert.ok(!cue.thread("thr_gt_lease")!.actions.some((x) => x.id === a.id));
});

test("opening a thread counts searches saved in other apps", async () => {
  const cue = await demoCue();
  cue.thread("thr_gt_mom", { countView: true });
  cue.thread("thr_gt_mom", { countView: true }); // counted once
  assert.equal(cue.summary().metrics.appSearchesSaved, 1);
});
