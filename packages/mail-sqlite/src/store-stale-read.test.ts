import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalRevision } from "@inboxzero/mail-core/identities";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// A provider read describes the message as it was when the read was sent. One
// sent before a local change was confirmed must not undo that change, even
// when the provider's version can't say which copy is newer.
describe("provider reads sent before a confirmed local change", () => {
  it("keeps an Outlook star when a sync page read before it lands", async () => {
    const store = await mailbox("microsoft", "K0");
    const requestedAt = await store.readRevision();
    await star(store, [patch("microsoft", "K1", { starred: true })]);

    await applyPage(store, "1", "2", [patch("microsoft", "K0")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps a star confirmed without a fresh copy when a read at the same version lands", async () => {
    const store = await mailbox("google", "10");
    const requestedAt = await store.readRevision();
    // The command went through but the copy after it couldn't be read, so
    // the store holds the change at the version it had before.
    await star(store, []);

    await applyPage(store, "1", "2", [patch("google", "10")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps the change against a hydration read before it at the same version", async () => {
    const store = await mailbox("microsoft", "K0");
    const requestedAt = await store.readRevision();
    await star(store, []);

    await store.applyHydration({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "hydrate-1",
      changes: [patch("microsoft", "K0")],
      bodies: [],
      requestedAt,
    });

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("applies a remote change read after the local one", async () => {
    const store = await mailbox("microsoft", "K0");
    await star(store, [patch("microsoft", "K1", { starred: true })]);
    const requestedAt = await store.readRevision();

    // Unstarred in Outlook on the web afterwards.
    await applyPage(store, "1", "2", [patch("microsoft", "K2")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: false });
    await store.close();
  });

  it("applies a Gmail copy provably newer than the one the change kept", async () => {
    const store = await mailbox("google", "10");
    const requestedAt = await store.readRevision();
    await star(store, []);

    await applyPage(
      store,
      "1",
      "2",
      [patch("google", "30", { starred: false, read: true })],
      requestedAt,
    );

    expect(await readM1(store)).toMatchObject({ starred: false, read: true });
    await store.close();
  });

  it("still applies a deletion read before the change", async () => {
    const store = await mailbox("microsoft", "K0");
    const requestedAt = await store.readRevision();
    await star(store, [patch("microsoft", "K1", { starred: true })]);

    await applyPage(
      store,
      "1",
      "2",
      [
        {
          kind: "message_deleted",
          key: { accountId: "acc-1", messageId: "m1" },
          evidence: "deleted",
        },
      ],
      requestedAt,
    );

    expect(await readM1(store)).toBeNull();
    await store.close();
  });

  it("still adds a new message from a read sent before the change", async () => {
    const store = await mailbox("microsoft", "K0");
    const requestedAt = await store.readRevision();
    await star(store, [patch("microsoft", "K1", { starred: true })]);

    await applyPage(
      store,
      "1",
      "2",
      [
        patch("microsoft", "K0"),
        { ...patch("microsoft", "N0", {}, "m2"), key: m2Key },
      ],
      requestedAt,
    );

    const inspection = await store.inspect();
    expect(
      inspection.messages.map((message) => [
        message.messageId,
        message.confirmed.starred,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["m1", true],
        ["m2", false],
      ]),
    );
    await store.close();
  });

  it("orders a read in flight across an owner handoff by the shared database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-stale-read-"));
    const path = join(directory, "mail.sqlite");
    try {
      const previousOwner = await mailbox("microsoft", "K0", path);
      const requestedAt = await previousOwner.readRevision();
      // Another tab takes over and confirms a star while the read is out.
      const nextOwner = await createSqliteMailStore(
        createNodeSqliteDriver(path),
      );
      await star(nextOwner, [patch("microsoft", "K1", { starred: true })]);

      await applyPage(
        previousOwner,
        "1",
        "2",
        [patch("microsoft", "K0")],
        requestedAt,
      );

      expect(await readM1(nextOwner)).toMatchObject({ starred: true });
      await previousOwner.close();
      await nextOwner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const m2Key = { accountId: "acc-1", messageId: "m2" };

async function mailbox(
  provider: "google" | "microsoft",
  version: string,
  path?: string,
) {
  const store = await createSqliteMailStore(createNodeSqliteDriver(path));
  await store.ensureAccount({ accountId: "acc-1", provider, generation: "g1" });
  await applyPage(store, null, "1", [patch(provider, version)]);
  return store;
}

async function star(store: MailStore, observations: ProviderChange[]) {
  const admission = await store.admitMetadata({
    accountId: "acc-1",
    commandId: `star-${Math.random()}`,
    targets: [{ accountId: "acc-1", messageId: "m1" }],
    change: { kind: "set_starred", starred: true },
  });
  expect(admission.status).toBe("queued");
  const work = await store.claimWork({
    ownerId: "owner",
    nowMs: Date.now(),
    leaseMs: 30_000,
  });
  if (work?.kind !== "command") throw new Error("expected the star");
  await store.settleAttempt({
    attemptId: work.attemptId,
    operation: work.operation,
    result: {
      status: "confirmed",
      receiptId: null,
      observations,
      targets: [
        {
          key: { accountId: "acc-1", messageId: "m1" },
          outcome: "applied",
          code: null,
        },
      ],
    },
  });
  expect(await readM1(store)).toMatchObject({ starred: true });
}

async function applyPage(
  store: MailStore,
  fromCheckpoint: string | null,
  toCheckpoint: string,
  changes: ProviderChange[],
  requestedAt?: LocalRevision,
) {
  const applied = await store.applySyncPage({
    ownerId: "owner",
    ...(requestedAt && { requestedAt }),
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: `page-${toCheckpoint}`,
      from: {
        streamId: "primary",
        generation: "g1",
        checkpoint: fromCheckpoint,
      },
      to: { streamId: "primary", generation: "g1", checkpoint: toCheckpoint },
      changes,
      requiredHydration: [],
      roundComplete: true,
    },
  });
  expect(applied.status).toBe("committed");
}

async function readM1(store: MailStore) {
  const inspection = await store.inspect();
  const message = inspection.messages.find(
    (candidate) => candidate.messageId === "m1" && !candidate.deleted,
  );
  return message?.effective ?? null;
}

function patch(
  provider: "google" | "microsoft",
  version: string,
  fields: { starred?: boolean; read?: boolean } = {},
  messageId = "m1",
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider,
      messageId,
      conversationId: `c-${messageId}`,
      version,
    },
    fields: {
      subject: "subject",
      preview: "preview",
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: fields.read ?? false,
      starred: fields.starred ?? false,
      folderId: "inbox",
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
