import assert from "node:assert/strict";
import { test } from "node:test";
import { gmailMessages, outlookMessages } from "../src/ingest/fixtures.ts";
import { fromGmail, fromOutlook, parseAddress } from "../src/ingest/normalize.ts";

test("parseAddress handles display names and bare addresses", () => {
  assert.deepEqual(parseAddress("Dana Kim <Dana.Kim@Example.org>"), { name: "Dana Kim", email: "dana.kim@example.org" });
  assert.deepEqual(parseAddress("solo@example.org"), { email: "solo@example.org" });
});

test("Gmail and Outlook messages normalize to the same shape", () => {
  const g = fromGmail(gmailMessages[1], "acct_gmail");
  assert.equal(g.threadId, "thr_gt_soccer");
  assert.equal(g.from.email, "dana.kim@eastsideyouthsoccer.org");
  assert.match(g.body, /Can Maya make it\?/); // base64url body decoded
  assert.equal(g.sentAt, "2026-10-12T18:20:00.000Z");

  const o = fromOutlook(outlookMessages[0], "acct_outlook");
  assert.equal(o.threadId, "thr_ot_united");
  assert.equal(o.source.provider, "outlook");
  assert.deepEqual(Object.keys(o).sort(), Object.keys(g).sort());
});
