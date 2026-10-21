import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const MESSAGES = 50_000;
const CONTACTS = 4000;
// One in ten messages is with the person the card opens on: someone you've
// written to for years, the slowest card this mailbox can ask for.
const HEAVY_EVERY = 10;
const BUDGET_MS = 100;

it("renders a person card in under 100 ms on a 50k-message mailbox", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    await store.ensureAccount({
      accountId: "a",
      provider: "google",
      generation: "g",
    });
    await driver.write(async (tx) => {
      for (let i = 0; i < MESSAGES; i++) {
        const heavy = i % HEAVY_EVERY === 0;
        const mine = i % 3 === 0;
        const person = heavy
          ? "Ana Lima <ana@example.com>"
          : `Person ${i % CONTACTS} <person${i % CONTACTS}@example.com>`;
        const conversation = heavy
          ? `ana-${Math.floor(i / (HEAVY_EVERY * 4))}`
          : `c-${Math.floor(i / 3)}`;
        const labels = heavy && i % 250 === 0 ? '["L_TO_REPLY"]' : "[]";
        await tx.execute(
          `INSERT INTO messages(account_id,message_id,conversation_id,provider,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments)
          VALUES ('a', ?, ?, 'google', 'Subject', '', ?, ?, '[]', ?, 1, 0, ?, '[]', ?, ?, ?, 0, 0, 0, ?)`,
          [
            String(i),
            conversation,
            mine ? "Me <me@example.com>" : person,
            JSON.stringify([mine ? person : "me@example.com"]),
            1_700_000_000_000 + i * 60_000,
            labels,
            mine ? '["sent"]' : '["inbox"]',
            mine ? 0 : 1,
            mine ? 1 : 0,
            heavy && !mine && i % 7 === 0 ? 1 : 0,
          ],
        );
        if (heavy && !mine && i % 7 === 0)
          await tx.execute(
            "INSERT INTO message_content(account_id, message_id, version, html, text, attachments_json) VALUES ('a', ?, '1', NULL, 'x', ?)",
            [
              String(i),
              JSON.stringify([
                {
                  attachmentId: `att-${i}`,
                  filename: `file-${i}.pdf`,
                  mimeType: "application/pdf",
                  size: 1000 + i,
                  inline: false,
                },
              ]),
            ],
          );
      }
      await tx.exec(`
        INSERT INTO effective_messages(account_id,message_id,conversation_id,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments,pending_operation_ids_json)
        SELECT account_id,message_id,conversation_id,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments,'[]'
        FROM messages
      `);
    });
    while ((await store.indexContactBacklog()).remaining) {
      /* bounded worker batches */
    }

    const query = {
      accountIds: ["a"],
      ownAddresses: ["me@example.com"],
      replyTracking: [
        {
          accountId: "a",
          toReplyLabelId: "L_TO_REPLY",
          awaitingReplyLabelId: null,
        },
      ],
    };
    const timings = { heavy: [] as number[], light: [] as number[] };
    for (let round = 0; round < 15; round++) {
      let start = performance.now();
      const card = await store.readPersonCard({
        ...query,
        email: "ana@example.com",
      });
      timings.heavy.push(performance.now() - start);
      expect(card.conversations).toHaveLength(6);
      expect(card.files).toHaveLength(6);
      expect(card.awaitingYou.length).toBeGreaterThan(0);
      expect(card.replyLag.theirs).not.toBeNull();

      start = performance.now();
      await store.readPersonCard({
        ...query,
        email: `person${round}@example.com`,
      });
      timings.light.push(performance.now() - start);
    }
    const heavy = summarize(timings.heavy);
    const light = summarize(timings.light);
    process.stdout.write(
      `PERSON_CARD_BENCH messages=${MESSAGES} heavy_contact_messages=${MESSAGES / HEAVY_EVERY} heavy_median_ms=${heavy.median.toFixed(2)} heavy_max_ms=${heavy.max.toFixed(2)} light_median_ms=${light.median.toFixed(2)} light_max_ms=${light.max.toFixed(2)}\n`,
    );
    expect(heavy.median).toBeLessThan(BUDGET_MS);
    expect(light.median).toBeLessThan(BUDGET_MS);

    // The person's messages come from an index, never a scan of the mailbox.
    const plan = await driver.read((tx) =>
      tx.query(
        "EXPLAIN QUERY PLAN SELECT message_id FROM contact_interactions WHERE account_id = ? AND email = ? ORDER BY last_at DESC LIMIT 10",
        ["a", "ana@example.com"],
      ),
    );
    expect(
      plan.some((row) =>
        /SEARCH contact_interactions/.test(String(row.detail)),
      ),
    ).toBe(true);
  } finally {
    await store.close();
  }
}, 180_000);

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}
