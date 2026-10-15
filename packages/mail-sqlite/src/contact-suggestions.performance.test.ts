import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

it("queries indexed prefixes in a 24k-message / 6k-contact store", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    await store.ensureAccount({
      accountId: "a",
      provider: "google",
      generation: "g",
    });
    await driver.write(async (tx) => {
      for (let i = 0; i < 24_000; i++) {
        await tx.execute(
          `INSERT INTO messages(account_id,message_id,conversation_id,provider,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments)
          VALUES ('a', ?, ?, 'google', '', '', ?, '["me@example.com"]', '[]', ?, 1, 0, '[]', '[]', '[]', 1, 0, 0, 0, 0, 0)`,
          [
            String(i),
            String(i),
            `Person ${i % 6000} <person${i % 6000}@example.com>`,
            1_800_000_000_000 + i,
          ],
        );
      }
    });
    while ((await store.indexContactBacklog()).remaining) {
      /* bounded worker batches */
    }
    // Each round times every query and one LIKE scan of all 24k messages,
    // the work an unindexed lookup would do, so host load hits both alike.
    const queries = [
      "person",
      "person1",
      "person23",
      "599",
      "person5999@",
      "missing",
    ];
    const timings = new Map(queries.map((query) => [query, [] as number[]]));
    const scans: number[] = [];
    for (let round = 0; round < 20; round++) {
      for (const query of queries) {
        const start = performance.now();
        const results = await store.readContactSuggestions({
          accountId: "a",
          ownAddresses: ["me@example.com"],
          excludeEmails: [],
          query,
        });
        timings.get(query)?.push(performance.now() - start);
        expect(results.length).toBeLessThanOrEqual(6);
      }
      const start = performance.now();
      await driver.read((tx) =>
        tx.query(
          "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND from_address LIKE ?",
          ["a", "%person1%"],
        ),
      );
      scans.push(performance.now() - start);
    }
    const scan = median(scans);
    const medians = Object.fromEntries(
      queries.map((query) => [query, median(timings.get(query) ?? [])]),
    );
    process.stdout.write(
      `CONTACT_QUERY_BENCH messages=24000 contacts=6000 rounds=20 scan_median_ms=${scan.toFixed(2)} ${queries.map((query) => `${query}=${medians[query].toFixed(2)}`).join(" ")}\n`,
    );
    // "person" ranks all 6k contacts and runs about 4x one scan.
    for (const query of queries) {
      expect(medians[query] / scan).toBeLessThan(15);
    }
    // A narrow prefix reads a handful of index rows, about 20x under a scan.
    for (const query of ["person23", "599", "person5999@", "missing"]) {
      expect(medians[query] / scan).toBeLessThan(1);
    }
    const plan = await driver.read((tx) =>
      tx.query(
        "EXPLAIN QUERY PLAN SELECT email FROM contact_tokens WHERE account_id = ? AND token >= ? AND token < ?",
        ["a", "person1", "person1\u{10ffff}"],
      ),
    );
    expect(plan.some((row) => String(row.detail).includes("SEARCH"))).toBe(
      true,
    );
  } finally {
    await store.close();
  }
}, 120_000);

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
