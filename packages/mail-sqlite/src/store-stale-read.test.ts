import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type { LocalRevision } from "@inboxzero/mail-core/identities";
import type {
  ClaimedWork,
  MailStore,
} from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// A provider read describes the message as it was when the read was sent. One
// sent before a local change was confirmed must not undo that change, even
// when the provider's version can't say which copy is newer. Outlook patches
// carry no version at all.
describe("provider reads sent before a confirmed local change", () => {
  it("keeps an Outlook star when a sync page read before it lands", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await applyPage(store, "1", "2", [patch("microsoft")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps a star confirmed without a fresh copy when a read at the same version lands", async () => {
    const store = await mailbox("google");
    const requestedAt = await store.readRevision();
    // The command went through but the copy after it couldn't be read, so
    // the store holds the change at the version it had before.
    await confirm(store, STAR, []);

    await applyPage(store, "1", "2", [patch("google")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps the change against a hydration read before it, and doesn't count it as applied", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, []);

    const hydrated = await store.applyHydration({
      session: SESSION,
      requestId: "hydrate-1",
      changes: [patch("microsoft")],
      bodies: [],
      requestedAt,
    });

    expect(hydrated.status).toBe("stale");
    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps the change against a bootstrap page read before it", async () => {
    const store = await mailbox("microsoft");
    const from = { streamId: "primary", generation: "g1", checkpoint: "1" };
    await store.startBootstrapScan({
      session: SESSION,
      scopeId: "account:all",
      bootstrapId: "boot",
      page: "page-1",
      from,
      catchUpFrom: null,
      nowMs: 1000,
    });
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    const applied = await store.applyBootstrapPage({
      session: SESSION,
      scopeId: "account:all",
      bootstrapId: "boot",
      previousPage: "page-1",
      nextPage: "page-2",
      from,
      catchUpFrom: null,
      requestId: "boot-page",
      changes: [patch("microsoft")],
      requiredHydration: [],
      bodies: [],
      ownerId: "owner",
      requestedAt,
    });

    expect(applied.status).toBe("committed");
    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps the change against a conversation read before it", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await store.applyConversationMembership({
      session: SESSION,
      page: {
        conversation: { accountId: "acc-1", conversationId: "c-m1" },
        resolutionId: "open-1",
        keys: [M1],
        changes: [patch("microsoft")],
        nextPage: null,
        evidence: null,
      },
      requestedAt,
    });

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("keeps the change against a command's preparation read before it", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);
    const admission = await store.admitConversations({
      accountId: "acc-1",
      commandId: "label-c1",
      conversations: [{ accountId: "acc-1", conversationId: "c-m1" }],
      change: {
        kind: "set_membership",
        membership: "category",
        id: "Blue",
        present: true,
      },
      observedRevision: (await store.inspect()).revision,
    });
    expect(admission.status).toBe("preparing");
    const work = await claim(store, "prepare");

    await store.applyPreparationPage({
      accountId: "acc-1",
      commandId: "label-c1",
      attemptId: work.attemptId,
      session: work.session,
      previousPage: work.page,
      page: {
        conversation: { accountId: "acc-1", conversationId: "c-m1" },
        resolutionId: work.resolutionId,
        keys: [M1],
        changes: [patch("microsoft")],
        nextPage: null,
        evidence: null,
      },
      requestedAt,
    });

    expect((await readConfirmedM1(store))?.starred).toBe(true);
    await store.close();
  });

  it("treats a read dated in another database epoch as older than the change", async () => {
    const store = await mailbox("microsoft");
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await applyPage(store, "1", "2", [patch("microsoft")], {
      databaseEpoch: "another-database",
      sequence: 1_000_000,
    });

    expect(await readM1(store)).toMatchObject({ starred: true });
    await store.close();
  });

  it("re-reads a skipped message, so a remote edit it carried still lands", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);
    // A rule in Outlook filed the message while the star was going out.
    await applyPage(
      store,
      "1",
      "2",
      [patch("microsoft", { archived: true })],
      requestedAt,
    );
    expect(await readM1(store)).toMatchObject({ starred: true });

    const reread = await claim(store, "hydrate");
    expect(reread).toMatchObject({ keys: [M1], purpose: "metadata" });
    await store.applyHydration({
      session: SESSION,
      requestId: reread.jobId,
      attemptId: reread.attemptId,
      changes: [patch("microsoft", { starred: true, archived: true })],
      bodies: [],
      requestedAt: await store.readRevision(),
    });

    expect(await readM1(store)).toMatchObject({
      starred: true,
      folderId: "archive",
      roles: [],
    });
    await store.close();
  });

  it("runs a re-read again when it was itself sent before a later change", async () => {
    const store = await mailbox("microsoft");
    const firstRead = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);
    await applyPage(store, "1", "2", [patch("microsoft")], firstRead);
    const reread = await claim(store, "hydrate");
    const rereadSentAt = await store.readRevision();
    await confirm(store, { kind: "set_read", read: true }, [
      patch("microsoft", { starred: true, read: true }),
    ]);

    const late = await store.applyHydration({
      session: SESSION,
      requestId: reread.jobId,
      attemptId: reread.attemptId,
      changes: [patch("microsoft", { starred: true })],
      bodies: [],
      requestedAt: rereadSentAt,
    });
    await store.completeJob({
      jobId: reread.jobId,
      attemptId: reread.attemptId,
    });

    expect(late.status).toBe("stale");
    expect(await readM1(store)).toMatchObject({ starred: true, read: true });
    expect(await claim(store, "hydrate")).toMatchObject({
      jobId: reread.jobId,
      keys: [M1],
    });
    await store.close();
  });

  it("applies a remote change read after the local one", async () => {
    const store = await mailbox("microsoft");
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);
    const requestedAt = await store.readRevision();

    // Unstarred in Outlook on the web afterwards.
    await applyPage(store, "1", "2", [patch("microsoft")], requestedAt);

    expect(await readM1(store)).toMatchObject({ starred: false });
    await store.close();
  });

  it("applies a Gmail copy provably newer than the one the change kept", async () => {
    const store = await mailbox("google");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, []);

    await applyPage(
      store,
      "1",
      "2",
      [patch("google", { read: true }, "30")],
      requestedAt,
    );

    expect(await readM1(store)).toMatchObject({ starred: false, read: true });
    await store.close();
  });

  it("still applies a deletion read before the change", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await applyPage(
      store,
      "1",
      "2",
      [{ kind: "message_deleted", key: M1, evidence: "deleted" }],
      requestedAt,
    );

    expect(await readM1(store)).toBeNull();
    await store.close();
  });

  // Only message patches are dated; a removal from a folder still applies.
  it("still applies a removal from the inbox read before the change", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await applyPage(
      store,
      "1",
      "2",
      [{ kind: "removed_from_scope", key: M1, scopeId: "inbox" }],
      requestedAt,
    );

    expect(await readM1(store)).toMatchObject({ starred: true, roles: [] });
    await store.close();
  });

  it("still adds a new message from a read sent before the change", async () => {
    const store = await mailbox("microsoft");
    const requestedAt = await store.readRevision();
    await confirm(store, STAR, [patch("microsoft", { starred: true })]);

    await applyPage(
      store,
      "1",
      "2",
      [patch("microsoft"), patch("microsoft", {}, null, "m2")],
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
    await withDatabaseFile(async (path) => {
      const previousOwner = await mailbox("microsoft", path);
      const requestedAt = await previousOwner.readRevision();
      // Another tab takes over and confirms a star while the read is out.
      const nextOwner = await createSqliteMailStore(
        createNodeSqliteDriver(path),
      );
      await confirm(nextOwner, STAR, [patch("microsoft", { starred: true })]);

      await applyPage(
        previousOwner,
        "1",
        "2",
        [patch("microsoft")],
        requestedAt,
      );

      expect(await readM1(nextOwner)).toMatchObject({ starred: true });
      await previousOwner.close();
      await nextOwner.close();
    });
  });

  it("guards a mailbox created before the change was tracked", async () => {
    await withDatabaseFile(async (path) => {
      await (await mailbox("microsoft", path)).close();
      const legacy = new DatabaseSync(path);
      legacy.exec("ALTER TABLE messages DROP COLUMN local_change_sequence");
      legacy.close();

      const store = await createSqliteMailStore(createNodeSqliteDriver(path));
      expect(await readM1(store)).toMatchObject({ starred: false });
      const requestedAt = await store.readRevision();
      await confirm(store, STAR, [patch("microsoft", { starred: true })]);
      await applyPage(store, "1", "2", [patch("microsoft")], requestedAt);

      expect(await readM1(store)).toMatchObject({ starred: true });
      await store.close();
    });
  });
});

const SESSION = { accountId: "acc-1", generation: "g1" };
const M1 = { accountId: "acc-1", messageId: "m1" };
const STAR: MetadataChange = { kind: "set_starred", starred: true };

async function mailbox(provider: "google" | "microsoft", path?: string) {
  const store = await createSqliteMailStore(createNodeSqliteDriver(path));
  await store.ensureAccount({ accountId: "acc-1", provider, generation: "g1" });
  await applyPage(store, null, "1", [patch(provider)]);
  return store;
}

async function confirm(
  store: MailStore,
  change: MetadataChange,
  observations: ProviderChange[],
) {
  const admission = await store.admitMetadata({
    accountId: "acc-1",
    commandId: `${change.kind}-${Math.random()}`,
    targets: [M1],
    change,
  });
  expect(admission.status).toBe("queued");
  const work = await claim(store, "command");
  await store.settleAttempt({
    attemptId: work.attemptId,
    operation: work.operation,
    result: {
      status: "confirmed",
      receiptId: null,
      observations,
      targets: [{ key: M1, outcome: "applied", code: null }],
    },
  });
}

async function claim<Kind extends ClaimedWork["kind"]>(
  store: MailStore,
  kind: Kind,
): Promise<Extract<ClaimedWork, { kind: Kind }>> {
  const work = await store.claimWork({
    ownerId: "owner",
    nowMs: Date.now(),
    leaseMs: 30_000,
  });
  if (work?.kind !== kind) {
    throw new Error(`expected ${kind} work, got ${work?.kind ?? "none"}`);
  }
  return work as Extract<ClaimedWork, { kind: Kind }>;
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
      session: SESSION,
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

async function readConfirmedM1(store: MailStore) {
  const inspection = await store.inspect();
  return inspection.messages.find((candidate) => candidate.messageId === "m1")
    ?.confirmed;
}

async function withDatabaseFile(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mail-stale-read-"));
  try {
    await run(join(directory, "mail.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function patch(
  provider: "google" | "microsoft",
  fields: { starred?: boolean; read?: boolean; archived?: boolean } = {},
  version: string | null = provider === "google" ? "10" : null,
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
      folderId: fields.archived ? "archive" : "inbox",
      labelIds: fields.archived ? [] : ["INBOX"],
      categoryIds: [],
      roles: fields.archived ? [] : ["inbox"],
      hasAttachments: false,
    },
  };
}
