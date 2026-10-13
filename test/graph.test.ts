import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFacts } from "../src/graph/facts.ts";
import { isValidAt, TemporalGraph } from "../src/graph/graph.ts";

test("facts carry the validity window stated in the document", () => {
  const facts = extractFacts("Term: Nov 1, 2025 to Oct 31, 2026. Monthly rent: $2,050. Increases are capped at 5% of rent.");
  const rent = facts.find((f) => f.key === "rent")!;
  assert.equal(rent.value, 2050);
  assert.equal(rent.proposed, false);
  assert.equal(rent.validTo?.slice(0, 10), "2026-10-31");
  assert.equal(facts.find((f) => f.key === "increase_cap_pct")?.value, 5);
});

test("offers are extracted as proposed facts", () => {
  const [offer] = extractFacts("We're offering a 12-month renewal at $2,150/month.");
  assert.deepEqual([offer.key, offer.value, offer.proposed], ["rent", 2150, true]);
});

test("invalidated edges are kept for history but not valid afterwards", () => {
  const g = new TemporalGraph();
  g.upsertNode("a", "person", "A");
  g.upsertNode("b", "org", "B");
  const e = g.addEdge({ type: "works_at", from: "a", to: "b", validFrom: "2024-01-01T00:00:00Z", confidence: 1 });
  g.invalidate(e.id, "2025-06-01T00:00:00Z");
  assert.equal(g.neighbors("a", { at: "2025-01-01T00:00:00Z" }).length, 1);
  assert.equal(g.neighbors("a", { at: "2025-07-01T00:00:00Z" }).length, 0);
  assert.equal(g.neighbors("a").length, 1);
  assert.ok(!isValidAt(e, "2025-06-01T00:00:00Z"));
});
