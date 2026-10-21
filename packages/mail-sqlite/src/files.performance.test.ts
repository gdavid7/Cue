import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { FilesQuery } from "@inboxzero/mail-core/queries";
import type { SqliteDriver, SqlTransaction, SqlValue } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const MESSAGES = 10_000;
// One message in four carries files, a heavy mailbox for attachments.
const FILES_EVERY = 4;
const BUDGET_MS = 100;

it("shows the first page of files in under 100 ms on a 10k-message mailbox", async () => {
  const { driver, queries } = recordingDriver();
  const store = await createSqliteMailStore(driver);
  try {
    for (const accountId of ["a", "b"])
      await store.ensureAccount({
        accountId,
        provider: "google",
        generation: "g",
      });
    await driver.write(async (tx) => {
      for (let i = 0; i < MESSAGES; i++) {
        const accountId = i % 2 ? "b" : "a";
        const files = i % FILES_EVERY === 0;
        await tx.execute(
          `INSERT INTO effective_messages(account_id,message_id,conversation_id,subject,preview,from_address,to_json,cc_json,received_at_ms,read,starred,label_ids_json,category_ids_json,roles_json,in_inbox,in_sent,in_draft,in_trash,in_spam,has_attachments,pending_operation_ids_json)
           VALUES (?, ?, ?, 'Subject', '', ?, '[]', '[]', ?, 1, 0, '[]', '[]', '["inbox"]', 1, 0, 0, 0, 0, ?, '[]')`,
          [
            accountId,
            String(i),
            `c-${Math.floor(i / 3)}`,
            `Person ${i % 300} <person${i % 300}@example.com>`,
            1_700_000_000_000 + i * 60_000,
            files ? 1 : 0,
          ],
        );
        await tx.execute(
          "INSERT INTO message_content(account_id, message_id, version, html, text, attachments_json) VALUES (?, ?, '1', NULL, 'x', ?)",
          [
            accountId,
            String(i),
            JSON.stringify(
              files
                ? [
                    attachment(`logo-${i}.png`, "image/png", true),
                    attachment(`report-${i}.pdf`, "application/pdf"),
                    attachment(`sheet-${i}.xlsx`, "application/octet-stream"),
                  ]
                : [],
            ),
          ],
        );
      }
    });

    const query: FilesQuery = {
      accountIds: ["a", "b"],
      kind: null,
      sender: null,
      name: null,
      pageSize: 100,
      after: null,
    };
    queries.length = 0;
    const timings: Record<string, number[]> = { all: [], kind: [], sender: [] };
    for (let round = 0; round < 15; round++) {
      let start = performance.now();
      const page = await store.readFiles(query);
      timings.all.push(performance.now() - start);
      expect(page.files).toHaveLength(100);
      expect(page.nextPage).not.toBeNull();

      start = performance.now();
      await store.readFiles({ ...query, kind: "spreadsheet" });
      timings.kind.push(performance.now() - start);

      start = performance.now();
      await store.readFiles({
        ...query,
        sender: `person${round * 4}@example.com`,
      });
      timings.sender.push(performance.now() - start);
    }
    const medians = Object.fromEntries(
      Object.entries(timings).map(([name, values]) => [name, median(values)]),
    );
    process.stdout.write(
      `FILES_BENCH messages=${MESSAGES} ${Object.entries(medians)
        .map(([name, value]) => `${name}_median_ms=${value.toFixed(2)}`)
        .join(" ")}\n`,
    );
    for (const value of Object.values(medians))
      expect(value).toBeLessThan(BUDGET_MS);

    // Walks mail with files newest first through its own index, never a
    // sort of the whole mailbox.
    const read = queries.find(({ sql }) => sql.includes("AS indexed"));
    if (!read) throw new Error("readFiles ran no query");
    const plan = await driver.read((tx) =>
      tx.query(`EXPLAIN QUERY PLAN ${read.sql}`, read.bindings),
    );
    expect(plan.map((row) => String(row.detail))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^SCAN e USING INDEX effective_files_order/),
      ]),
    );
  } finally {
    await store.close();
  }
}, 60_000);

function attachment(filename: string, mimeType: string, inline = false) {
  return {
    attachmentId: `att-${filename}`,
    filename,
    mimeType,
    size: 1000,
    inline,
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

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
