import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, extractDates } from "../src/intent/classify.ts";

const NOW = "2026-10-13T16:00:00Z"; // Tuesday

test("one email can carry several intents", () => {
  const c = classify("Can Maya make it Saturday at 9:00am? Could you send her signed medical release form?", false);
  assert.ok(c.all.includes("scheduling"));
  assert.ok(c.all.includes("document_request"));
});

test("marketing language only counts as newsletter from automated senders", () => {
  assert.equal(classify("Deals! Unsubscribe anytime.", true).primary, "newsletter");
  assert.notEqual(classify("Did you unsubscribe from that list?", false).primary, "newsletter");
});

test("bills and decisions", () => {
  assert.equal(classify("Amount due: $84.12. Due date: Oct 24", true).primary, "bill");
  assert.equal(classify("Please confirm by Oct 20 whether you'd like to renew.", false).primary, "decision");
});

test("dates resolve against now", () => {
  assert.deepEqual(extractDates("rescheduled to this Saturday, Oct 17 at 9am", NOW), ["2026-10-17"]);
  assert.deepEqual(extractDates("see you this Saturday", NOW), ["2026-10-17"]);
  assert.deepEqual(extractDates("Departing Nov 25, 2026", NOW), ["2026-11-25"]);
  // A year-less date far in the past means next year.
  assert.deepEqual(extractDates("Jan 5", NOW), ["2027-01-05"]);
});

test("a bare weekday is too ambiguous to pin to this week", () => {
  assert.deepEqual(extractDates("are you flying in Wednesday or Thursday for Thanksgiving?", NOW), []);
});
