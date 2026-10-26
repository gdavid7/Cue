import { describe, expect, it } from "vitest";
import type {
  ClaimedWork,
  MailStore,
} from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const inboxQuery = {
  accountIds: ["acc-1"],
  predicate: { kind: "role" as const, role: "inbox" as const },
  order: "newest_first" as const,
  pageSize: 25,
  after: null,
};

// Undo is someone waiting on their row to come back. The row returns at once
// whatever the provider queue holds, an undo of a change nothing has sent
// yet never reaches the provider, and one that must be sent goes ahead of
// the other changes waiting their turn.
describe("undo of a conversation change", () => {
  it("shows the row again at once while the change it undoes is still on its way", async () => {
    const store = await mailbox(["m1"]);
    // Command ids are random, so the undo's may sort before the original's.
    await archive(store, "z-archive", "m1");
    const sending = await claimCommand(store);
    expect(sending.operation.key.operationId).toBe("z-archive");
    expect(await inboxConversations(store)).toEqual([]);

    await unarchive(store, "a-undo", "m1");

    expect(await inboxConversations(store)).toEqual(["c-m1"]);
    await store.close();
  });

  it("cancels a change the provider refused to start for quota instead of sending both", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive", "m1");
    const attempt = await claimCommand(store);
    await store.settleAttempt({
      attemptId: attempt.attemptId,
      operation: attempt.operation,
      result: {
        status: "not_dispatched",
        reason: "throttled",
        retryAfterMs: 60_000,
      },
    });

    expect(
      await store.cancelOperation({
        accountId: "acc-1",
        operationId: "archive",
      }),
    ).toMatchObject({ status: "cancelled" });

    expect(await inboxConversations(store)).toEqual(["c-m1"]);
    expect(await claimAny(store, Date.now() + 120_000)).toBeNull();
    await store.close();
  });

  it("keeps a change whose request may have reached the provider", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive", "m1");
    const attempt = await claimCommand(store);
    // A request that failed mid-flight is settled this way, and may have
    // been applied.
    await store.settleAttempt({
      attemptId: attempt.attemptId,
      operation: attempt.operation,
      result: {
        status: "not_dispatched",
        reason: "unavailable",
        retryAfterMs: 1000,
      },
    });

    expect(
      await store.cancelOperation({
        accountId: "acc-1",
        operationId: "archive",
      }),
    ).toEqual({ status: "too_late" });
    await store.close();
  });

  it("keeps a refused change cancellable only until it is sent again", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive", "m1");
    const first = await claimCommand(store);
    await store.settleAttempt({
      attemptId: first.attemptId,
      operation: first.operation,
      result: {
        status: "not_dispatched",
        reason: "throttled",
        retryAfterMs: 1,
      },
    });
    const second = await claimCommand(store, Date.now() + 1000);
    await store.settleAttempt({
      attemptId: second.attemptId,
      operation: second.operation,
      result: {
        status: "not_dispatched",
        reason: "unavailable",
        retryAfterMs: 1000,
      },
    });

    expect(
      await store.cancelOperation({
        accountId: "acc-1",
        operationId: "archive",
      }),
    ).toEqual({ status: "too_late" });
    await store.close();
  });

  it("keeps a change that may have reached the provider even after a later attempt is throttled", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive", "m1");
    const first = await claimCommand(store);
    // The response was lost after Gmail may have applied it.
    await settleNotDispatched(store, first, "unavailable");
    const second = await claimCommand(store, Date.now() + 1000);
    await settleNotDispatched(store, second, "throttled");

    expect(await cancel(store, "archive")).toEqual({ status: "too_late" });
    await store.close();
  });

  it("keeps a change reclaimed from an expired attempt even when the reclaim is throttled", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive", "m1");
    await claimCommand(store);
    // The first attempt may still be in flight when its lease runs out.
    const reclaimed = await claimCommand(store, Date.now() + 31_000);
    await settleNotDispatched(store, reclaimed, "throttled");

    expect(await cancel(store, "archive")).toEqual({ status: "too_late" });
    await store.close();
  });

  it("keeps a throttled change once an attempt it did not stamp has been made", async () => {
    const driver = createNodeSqliteDriver();
    const store = await mailbox(["m1"], { driver });
    await archive(store, "archive", "m1");
    const attempt = await claimCommand(store);
    await settleNotDispatched(store, attempt, "throttled");
    // A tab on a build without the stamp claims and settles it again.
    await driver.write((tx) =>
      tx.execute(
        "UPDATE operations SET attempt_id = 'older-build' WHERE command_id = 'archive'",
      ),
    );

    expect(await cancel(store, "archive")).toEqual({ status: "too_late" });
    await store.close();
  });

  it("holds an interactive undo behind an earlier conversation change still preparing", async () => {
    const store = await mailbox(["m1"], { complete: false });
    await store.admitConversations({
      accountId: "acc-1",
      commandId: "archive-c-m1",
      conversations: [{ accountId: "acc-1", conversationId: "c-m1" }],
      change: { kind: "archive" },
      observedRevision: await store.readRevision(),
    });
    const preparation = await claimAny(store);
    expect(preparation?.kind).toBe("prepare");
    await store.admitMetadata({
      accountId: "acc-1",
      commandId: "undo-m1",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "unarchive" },
      priority: "interactive",
    });

    expect(await claimAny(store)).toBeNull();
    await store.close();
  });

  it("prepares an interactive undo only after an earlier change to the same conversation", async () => {
    const store = await mailbox(["m1"], { complete: false });
    for (const [commandId, change, priority] of [
      ["archive-c-m1", { kind: "archive" }, undefined],
      ["undo-c-m1", { kind: "unarchive" }, "interactive"],
    ] as const) {
      await store.admitConversations({
        accountId: "acc-1",
        commandId,
        conversations: [{ accountId: "acc-1", conversationId: "c-m1" }],
        change,
        ...(priority ? { priority } : {}),
        observedRevision: await store.readRevision(),
      });
    }

    const next = await claimAny(store);
    if (next?.kind !== "prepare") throw new Error("expected prepare");
    expect(next.commandId).toBe("archive-c-m1");
    await store.close();
  });

  it("sends an interactive undo ahead of earlier changes to other mail", async () => {
    const store = await mailbox(["m1", "m2", "m3"]);
    await archive(store, "archive-m1", "m1");
    const sent = await claimCommand(store);
    await settleApplied(store, sent, "m1");
    await archive(store, "archive-m2", "m2");
    await archive(store, "archive-m3", "m3");

    const admission = await store.admitConversations({
      accountId: "acc-1",
      commandId: "undo-m1",
      conversations: [{ accountId: "acc-1", conversationId: "c-m1" }],
      change: { kind: "unarchive" },
      priority: "interactive",
      observedRevision: await store.readRevision(),
    });
    expect(admission.status).toBe("queued");

    const next = await claimCommand(store);
    expect(next.operation.key.operationId).toBe("undo-m1");
    await store.close();
  });

  it("sends an interactive move back ahead of earlier changes to other mail", async () => {
    const store = await mailbox(["m1", "m2"]);
    await archive(store, "archive-m2", "m2");
    await store.admitMetadata({
      accountId: "acc-1",
      commandId: "move-back-m1",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "move", folderId: "inbox" },
      priority: "interactive",
    });

    const next = await claimCommand(store);
    expect(next.operation.key.operationId).toBe("move-back-m1");
    await store.close();
  });

  it("still sends an interactive undo after the change it reverses", async () => {
    const store = await mailbox(["m1"]);
    await archive(store, "archive-m1", "m1");
    const attempt = await claimCommand(store);
    await store.settleAttempt({
      attemptId: attempt.attemptId,
      operation: attempt.operation,
      result: {
        status: "not_dispatched",
        reason: "unavailable",
        retryAfterMs: 1,
      },
    });
    await store.admitConversations({
      accountId: "acc-1",
      commandId: "undo-m1",
      conversations: [{ accountId: "acc-1", conversationId: "c-m1" }],
      change: { kind: "unarchive" },
      priority: "interactive",
      observedRevision: await store.readRevision(),
    });

    const next = await claimCommand(store, Date.now() + 1000);
    expect(next.operation.key.operationId).toBe("archive-m1");
    await store.close();
  });

  it("prepares an interactive undo ahead of earlier conversation commands", async () => {
    const store = await mailbox([]);
    for (const conversationId of ["c-a", "c-b"]) {
      await store.admitConversations({
        accountId: "acc-1",
        commandId: `archive-${conversationId}`,
        conversations: [{ accountId: "acc-1", conversationId }],
        change: { kind: "archive" },
        observedRevision: await store.readRevision(),
      });
    }
    await store.admitConversations({
      accountId: "acc-1",
      commandId: "undo-c-z",
      conversations: [{ accountId: "acc-1", conversationId: "c-z" }],
      change: { kind: "unarchive" },
      priority: "interactive",
      observedRevision: await store.readRevision(),
    });

    const next = await claimAny(store);
    expect(next?.kind).toBe("prepare");
    if (next?.kind !== "prepare") throw new Error("expected prepare");
    expect(next.commandId).toBe("undo-c-z");
    await store.close();
  });
});

async function mailbox(
  messageIds: string[],
  {
    driver = createNodeSqliteDriver(),
    complete = true,
  }: {
    driver?: ReturnType<typeof createNodeSqliteDriver>;
    complete?: boolean;
  } = {},
) {
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "boot",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: messageIds.map((messageId, index) =>
        inboxMessage(messageId, 1000 + index),
      ),
      requiredHydration: [],
      roundComplete: true,
    },
  });
  for (const messageId of complete ? messageIds : []) {
    await store.applyConversationMembership({
      session: { accountId: "acc-1", generation: "g1" },
      page: {
        conversation: { accountId: "acc-1", conversationId: `c-${messageId}` },
        resolutionId: `open-${messageId}`,
        keys: [{ accountId: "acc-1", messageId }],
        changes: [],
        nextPage: null,
        evidence: null,
      },
    });
  }
  return store;
}

async function archive(store: MailStore, commandId: string, messageId: string) {
  await store.admitMetadata({
    accountId: "acc-1",
    commandId,
    targets: [{ accountId: "acc-1", messageId }],
    change: { kind: "archive" },
  });
}

async function unarchive(
  store: MailStore,
  commandId: string,
  messageId: string,
) {
  await store.admitMetadata({
    accountId: "acc-1",
    commandId,
    targets: [{ accountId: "acc-1", messageId }],
    change: { kind: "unarchive" },
  });
}

async function settleNotDispatched(
  store: MailStore,
  work: Extract<ClaimedWork, { kind: "command" }>,
  reason: "throttled" | "unavailable",
) {
  await store.settleAttempt({
    attemptId: work.attemptId,
    operation: work.operation,
    result: { status: "not_dispatched", reason, retryAfterMs: 1 },
  });
}

function cancel(store: MailStore, operationId: string) {
  return store.cancelOperation({ accountId: "acc-1", operationId });
}

async function claimAny(store: MailStore, nowMs = Date.now()) {
  return store.claimWork({ ownerId: "owner", nowMs, leaseMs: 30_000 });
}

async function claimCommand(store: MailStore, nowMs = Date.now()) {
  const work = await claimAny(store, nowMs);
  if (work?.kind !== "command")
    throw new Error(`expected command, got ${work?.kind}`);
  return work as Extract<ClaimedWork, { kind: "command" }>;
}

async function settleApplied(
  store: MailStore,
  work: Extract<ClaimedWork, { kind: "command" }>,
  messageId: string,
) {
  await store.settleAttempt({
    attemptId: work.attemptId,
    operation: work.operation,
    result: {
      status: "confirmed",
      receiptId: null,
      observations: [],
      targets: [
        {
          key: { accountId: "acc-1", messageId },
          outcome: "applied",
          code: null,
        },
      ],
    },
  });
}

async function inboxConversations(store: MailStore) {
  const { view } = await store.readMailboxView(inboxQuery);
  return view.conversations.map((row) => row.key.conversationId);
}

function inboxMessage(
  messageId: string,
  receivedAtMs: number,
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider: "google",
      messageId,
      conversationId: `c-${messageId}`,
      version: "1",
    },
    fields: {
      subject: messageId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs,
      read: false,
      starred: false,
      folderId: "inbox",
      inboxSection: null,
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
