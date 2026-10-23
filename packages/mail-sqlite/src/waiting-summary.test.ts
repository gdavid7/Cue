import { describe, expect, it } from "vitest";
import { DEFERRED_DISPATCH_MIN_HOLD_MS } from "@inboxzero/mail-core/operations";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const NOW = 10_000_000;

describe("getWaitingSummary", () => {
  it("dates an account's wait from its waiting changes only", async () => {
    const { driver, store } = await harness();
    // An old partly applied change sits next to a fresh archive.
    await insertOperation(driver, {
      id: "old-partial",
      status: "needs_attention",
      payload: { kind: "conversations", change: { kind: "archive" } },
      createdAtMs: NOW - 86_400_000,
    });
    await insertOperation(driver, {
      id: "fresh-archive",
      status: "queued",
      payload: { kind: "conversations", change: { kind: "archive" } },
      createdAtMs: NOW - 1000,
    });

    const [summary] = await store.getWaitingSummary(["acc-1"], NOW);

    expect(summary).toEqual({
      accountId: "acc-1",
      connection: "ready",
      oldestWaitingAtMs: NOW - 1000,
      groups: [
        {
          status: "queued",
          kind: "conversations",
          changeKind: "archive",
          on: null,
          membership: null,
          heldOffline: false,
          count: 1,
          oldestWaitingAtMs: NOW - 1000,
        },
      ],
    });
    await store.close();
  });

  it("leaves out a send the server holds until later, then dates it from when it fell due", async () => {
    const { driver, store } = await harness();
    await insertOperation(driver, {
      id: "scheduled-send",
      status: "verifying",
      payload: { kind: "send", sendAtMs: NOW + 60_000 },
      createdAtMs: NOW - 120_000,
    });

    expect(await store.getWaitingSummary(["acc-1"], NOW)).toEqual([
      expect.objectContaining({ oldestWaitingAtMs: null, groups: [] }),
    ]);

    const [due] = await store.getWaitingSummary(["acc-1"], NOW + 61_000);
    expect(due?.oldestWaitingAtMs).toBe(NOW + 60_000);
    expect(due?.groups).toEqual([
      expect.objectContaining({ kind: "send", count: 1 }),
    ]);
    await store.close();
  });

  it("marks changes held for a connection, and groups on/off changes by value", async () => {
    const { driver, store } = await harness();
    await insertOperation(driver, {
      id: "offline-send",
      status: "queued",
      payload: { kind: "send" },
      createdAtMs: NOW - 5000,
      nextAttemptAtMs: NOW + DEFERRED_DISPATCH_MIN_HOLD_MS * 2,
    });
    for (const [id, present] of [
      ["label-a", true],
      ["label-b", true],
      ["unlabel", false],
    ] as const) {
      await insertOperation(driver, {
        id,
        status: "retry_wait",
        payload: {
          kind: "conversations",
          change: {
            kind: "set_membership",
            membership: "label",
            id: `Label ${id}`,
            present,
          },
        },
        createdAtMs: NOW - 40_000,
      });
    }

    const [summary] = await store.getWaitingSummary(["acc-1"], NOW);

    expect(summary?.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "send", heldOffline: true, count: 1 }),
        expect.objectContaining({
          changeKind: "set_membership",
          membership: "label",
          on: true,
          count: 2,
        }),
        expect.objectContaining({
          changeKind: "set_membership",
          on: false,
          count: 1,
        }),
      ]),
    );
    // Label names stay in the payload; the summary never carries them.
    expect(JSON.stringify(summary)).not.toContain("Label ");
    await store.close();
  });

  it("answers for every account asked about, signed out or unknown", async () => {
    const { driver, store } = await harness();
    await driver.write((tx) =>
      tx.execute("UPDATE accounts SET connection = 'blocked_auth'", []),
    );

    expect(await store.getWaitingSummary(["acc-1", "acc-2"], NOW)).toEqual([
      expect.objectContaining({
        accountId: "acc-1",
        connection: "blocked_auth",
      }),
      expect.objectContaining({ accountId: "acc-2", connection: "ready" }),
    ]);
    await store.close();
  });

  it("reads waiting changes through the account and status index", async () => {
    const { driver, store } = await harness();
    const plan = await driver.read((tx) =>
      tx.query(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM operations WHERE account_id IN (?) AND status IN (?, ?)",
        ["acc-1", "queued", "retry_wait"],
      ),
    );
    expect(JSON.stringify(plan)).toContain("operations_account_status");
    await store.close();
  });
});

async function harness() {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  await driver.write((tx) =>
    tx.execute(
      "INSERT INTO accounts(account_id, provider, generation) VALUES ('acc-1', 'google', 'g1')",
      [],
    ),
  );
  return { driver, store };
}

async function insertOperation(
  driver: SqliteDriver,
  input: {
    id: string;
    status: string;
    payload: Record<string, unknown>;
    createdAtMs: number;
    nextAttemptAtMs?: number;
  },
) {
  await driver.write((tx) =>
    tx.execute(
      `INSERT INTO operations(
         account_id, command_id, status, authority, intent_hash, payload_json,
         created_at_ms, next_attempt_at_ms
       ) VALUES ('acc-1', ?, ?, 'client', ?, ?, ?, ?)`,
      [
        input.id,
        input.status,
        input.id,
        JSON.stringify(input.payload),
        input.createdAtMs,
        input.nextAttemptAtMs ?? null,
      ],
    ),
  );
}
