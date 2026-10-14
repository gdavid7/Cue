import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { OperationExecutor } from "@inboxzero/mail-core/ports/operation-executor";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const KEY = { accountId: "acc-1", operationId: "archive-1" };

describe("engine command network failures", () => {
  it("retries a command whose request failed mid-flight after a short backoff", async () => {
    const { engine, store, executor } = await commandHarness();
    executor.execute.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await engine.runUntil(Date.now() + 200);

    const { operation } = await store.readOperation(KEY);
    expect(operation?.status).toBe("retry_wait");
    // Far sooner than the 30 s claim lease the engine used to wait out.
    expect(operation?.nextAttemptAtMs).toBeLessThanOrEqual(Date.now() + 5000);

    const retried = await store.claimWork({
      ownerId: "other-owner",
      nowMs: Date.now() + 5000,
      leaseMs: 30_000,
    });
    expect(retried).toMatchObject({
      kind: "command",
      operation: { key: KEY },
    });
    await engine.close();
  });

  it("backs off longer while the network stays down", async () => {
    const { engine, store, executor, driver } = await commandHarness();
    executor.execute.mockRejectedValue(new TypeError("Failed to fetch"));
    const delays: number[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const before = Date.now();
      await driver.write((tx) =>
        tx.execute("UPDATE operations SET next_attempt_at_ms = NULL"),
      );
      await engine.runUntil(Date.now() + 200);
      const { operation } = await store.readOperation(KEY);
      delays.push((operation?.nextAttemptAtMs ?? 0) - before);
    }

    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
    await engine.close();
  });
});

async function commandHarness() {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const executor = {
    execute: vi.fn<OperationExecutor["execute"]>(async () => ({
      status: "confirmed" as const,
      receiptId: null,
      observations: [],
      targets: [],
    })),
    inspect: vi.fn<OperationExecutor["inspect"]>(async () => ({
      status: "uncertain" as const,
      receiptId: null,
    })),
  };
  const engine = createMailEngine({
    store,
    source: idleSource(),
    executor,
    runtime: createHostRuntime(),
  });
  const admission = await engine.submitMetadata({
    accountId: "acc-1",
    commandId: KEY.operationId,
    targets: [{ accountId: "acc-1", messageId: "m1" }],
    change: { kind: "archive" },
  });
  expect(admission.status).toBe("queued");
  return { engine, store, executor, driver };
}

function idleSource(): MailboxSource {
  const paused = {
    status: "paused" as const,
    retryAfterMs: 60_000,
    reason: "unavailable" as const,
  };
  return {
    async describe() {
      return paused;
    },
    async discoverScopes() {
      return paused;
    },
    async beginBootstrap() {
      return paused;
    },
    async enumerate() {
      return paused;
    },
    async readChanges() {
      return paused;
    },
    async hydrate() {
      return paused;
    },
    async readConversationMembership() {
      return paused;
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return paused;
    },
  };
}
