import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { SqliteDriver, SqlTransaction, SqlValue } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const MESSAGES = 50_000;
const CONTACTS = 4000;
// One in ten messages is with the person the card opens on: someone you've
// written to for years, the slowest card this mailbox can ask for.
const HEAVY_EVERY = 10;
const BUDGET_MS = 100;
// Reads twice the rows of the heavy card, so it gets room for busy CI while
// still failing the quadratic matching it guards against (~390 ms median).
const COPY_BUDGET_MS = 250;

it("renders a person card in under 100 ms on a 50k-message mailbox", async () => {
  const { driver, queries } = recordingDriver();
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
    queries.length = 0;
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

    // Aliases come from the name's tokens and each match's own rows, never a
    // walk over every contact.
    const aliasQueries = queries.filter(({ sql }) =>
      sql.includes("contact_tokens"),
    );
    expect(aliasQueries.length).toBeGreaterThan(0);
    for (const { sql, bindings } of aliasQueries.slice(0, 1)) {
      const steps = await driver.read((tx) =>
        tx.query(`EXPLAIN QUERY PLAN ${sql}`, bindings),
      );
      const details = steps.map((row) => String(row.detail));
      expect(
        details.filter((detail) =>
          /^(SCAN|SEARCH) (?!\(subquery)/.test(detail),
        ),
      ).toEqual([
        expect.stringMatching(/^SEARCH t USING .*INDEX/),
        expect.stringMatching(
          /^SEARCH i USING INDEX contact_interaction_group/,
        ),
        expect.stringMatching(/^SEARCH m USING .*INDEX/),
      ]);
    }

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

it("matches copies in two accounts in under 250 ms when many messages look alike", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    // An automated-looking run: one sender, one subject, one recipient, a
    // message every 10 ms, in both accounts.
    const COPIES = 2100;
    for (const accountId of ["a", "b"])
      await store.ensureAccount({
        accountId,
        provider: "google",
        generation: "g",
      });
    await driver.write(async (tx) => {
      for (const [account, offset] of [
        ["a", 0],
        ["b", 5],
      ] as const) {
        for (let i = 0; i < COPIES; i++)
          await tx.execute(
            `INSERT INTO messages(account_id,message_id,conversation_id,provider,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments)
            VALUES (?, ?, ?, 'google', 'Status', '', 'Bo Silva <bo@example.com>', '["me@example.com"]', '[]', ?, 1, 0, '[]', '[]', '["inbox"]', 1, 0, 0, 0, 0, 0)`,
            [
              account,
              `${account}-${i}`,
              `${account}-${Math.floor(i / 5)}`,
              1_700_000_000_000 + i * 10 + offset,
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

    const timings: number[] = [];
    for (let round = 0; round < 15; round++) {
      const start = performance.now();
      const card = await store.readPersonCard({
        accountIds: ["a", "b"],
        email: "bo@example.com",
        ownAddresses: ["me@example.com"],
        replyTracking: [],
      });
      timings.push(performance.now() - start);
      // Each conversation is in both accounts, so it shows from one only.
      expect(new Set(card.conversations.map((c) => c.accountId)).size).toBe(1);
    }
    const { median, max } = summarize(timings);
    process.stdout.write(
      `PERSON_CARD_COPY_BENCH accounts=2 lookalike_messages=${COPIES} median_ms=${median.toFixed(2)} max_ms=${max.toFixed(2)}\n`,
    );
    expect(median).toBeLessThan(COPY_BUDGET_MS);
  } finally {
    await store.close();
  }
}, 180_000);

function recordingDriver() {
  const inner = createNodeSqliteDriver();
  const queries: Array<{ sql: string; bindings: readonly SqlValue[] }> = [];
  const record = (tx: SqlTransaction): SqlTransaction => ({
    exec: (sql) => tx.exec(sql),
    execute: (sql, bindings) => tx.execute(sql, bindings),
    query: (sql, bindings = []) => {
      queries.push({ sql, bindings });
      return tx.query(sql, bindings);
    },
  });
  const driver: SqliteDriver = {
    close: () => inner.close(),
    read: (work) => inner.read((tx) => work(record(tx))),
    write: (work) => inner.write((tx) => work(record(tx))),
  };
  return { driver, queries };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}
