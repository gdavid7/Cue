import assert from "node:assert/strict";
import { test } from "node:test";
import { EntityResolver, MERGE_THRESHOLD, orgFromEmail, SELF_ID } from "../src/resolve/entities.ts";

const make = () => {
  const r = new EntityResolver("Alex Rivera", ["alex@gmail.com", "alex@outlook.com"]);
  r.resolve({ name: "Dana Kim", email: "dana.kim@soccer.org" }, "Hornets practice at Garfield Park, games on Saturday");
  return r;
};

test("the user's own addresses resolve to one person", () => {
  const r = make();
  assert.equal(r.resolve({ email: "alex@outlook.com" }).personId, SELF_ID);
  assert.equal(r.resolve({ email: "ALEX@gmail.com" }).personId, SELF_ID);
});

test("an exact email match is deterministic (confidence 1)", () => {
  const r = make();
  const res = r.resolve({ email: "dana.kim@soccer.org" });
  assert.equal(res.method, "email");
  assert.equal(res.confidence, 1);
});

test("a nickname + supporting context merges, with confidence below 1", () => {
  const r = make();
  const res = r.resolve({ name: "Coach Dana", email: "dana.hornets@gmail.com" }, "Hornets practice Garfield Park");
  assert.equal(res.method, "name+context");
  assert.ok(res.confidence >= MERGE_THRESHOLD && res.confidence < 1, `confidence ${res.confidence}`);
  // ...and the new address is now a deterministic alias.
  assert.equal(r.resolve({ email: "dana.hornets@gmail.com" }).personId, res.personId);
});

test("a shared first name without supporting context stays a separate person", () => {
  const r = make();
  const res = r.resolve({ name: "Dana Smith", email: "dsmith@bakery.com" }, "Your cake order is ready");
  assert.equal(res.method, "new");
});

test("consumer mail domains don't imply an organization", () => {
  assert.equal(orgFromEmail("someone@gmail.com"), null);
  assert.equal(orgFromEmail("priya@maplecourtapts.com"), "maplecourtapts.com");
});
