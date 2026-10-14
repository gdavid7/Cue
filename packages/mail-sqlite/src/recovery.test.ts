import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver, wipeNodeMailbox } from "./node-sqlite";
import {
  classifyMailboxError,
  openMailStoreWithRecovery,
  type PendingMailWork,
  type PendingMailWorkStash,
} from "./recovery";
import { createSqliteMailStore } from "./store";

const DRAFT = { accountId: "acc-1", draftId: "d1" };
const inboxQuery = {
  accountIds: ["acc-1"],
  predicate: { kind: "role" as const, role: "inbox" as const },
  order: "newest_first" as const,
  pageSize: 10,
  after: null,
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("classifyMailboxError", () => {
  it("tells corruption, a held mailbox, and missing storage apart", () => {
    expect(
      classifyMailboxError(
        Object.assign(new Error("database disk image is malformed"), {
          errcode: 11,
        }),
      ),
    ).toBe("corrupt");
    expect(
      classifyMailboxError(
        new Error(
          "SQLITE_NOTADB: sqlite3 result code 26: file is not a database",
        ),
      ),
    ).toBe("corrupt");
    // Worker errors arrive as text, so OPFS handle contention is read from it.
    expect(
      classifyMailboxError(
        new Error(
          "NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle",
        ),
      ),
    ).toBe("busy");
    expect(
      classifyMailboxError(
        Object.assign(new Error("database is locked"), { errcode: 5 }),
      ),
    ).toBe("busy");
    expect(
      classifyMailboxError(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      ),
    ).toBe("unavailable");
    expect(classifyMailboxError(new Error("unexpected"))).toBeNull();
  });
});

describe("openMailStoreWithRecovery", () => {
  it("rebuilds a mailbox that fails to open and re-admits drafts and unsent commands", async () => {
    const path = await mailboxPath();
    await seedPendingWork(path);
    const stash = memoryStash();
    const onRebuild = vi.fn();
    let opens = 0;

    const store = await openMailStoreWithRecovery({
      open: async () => {
        opens += 1;
        const driver = createNodeSqliteDriver(path);
        return opens === 1 ? failingWrites(driver) : driver;
      },
      wipe: () => wipeNodeMailbox(path),
      stash,
      onRebuild,
    });

    expect(onRebuild).toHaveBeenCalledOnce();
    expect(await store.readDraft(DRAFT)).toMatchObject({
      status: "found",
      draftRevision: 1,
      content: { editableHtml: "<p>Thursday works.</p>" },
    });
    const { operation } = await store.readOperation({
      accountId: "acc-1",
      operationId: "archive-1",
    });
    expect(operation?.status).toBe("queued");
    // Finished commands are history, not work to carry over.
    const finished = await store.readOperation({
      accountId: "acc-1",
      operationId: "done-1",
    });
    expect(finished.operation).toBeNull();
    expect(await stash.read()).toBeNull();
    // The rebuilt mailbox syncs from scratch and still shows the archive the
    // user made before the rebuild.
    await syncInbox(store, ["m1", "m2"]);
    const inbox = await store.readMailboxView(inboxQuery);
    expect(
      inbox.view.conversations.map((row) => row.key.conversationId),
    ).toEqual(["c-m2"]);
    await store.close();
  });

  it("re-admits carried work exactly once after a reload mid-rebuild", async () => {
    const path = await mailboxPath();
    await seedPendingWork(path);
    const stash = memoryStash();
    await expect(
      openMailStoreWithRecovery({
        open: async () => failingWrites(createNodeSqliteDriver(path)),
        wipe: () => wipeNodeMailbox(path),
        stash,
      }),
    ).rejects.toThrow();
    // The page went away after the wipe; the stash outlived it.
    const carried = await stash.read();
    expect(carried?.operations).toHaveLength(1);

    for (let reload = 0; reload < 2; reload++) {
      const store = await openMailStoreWithRecovery({
        open: async () => createNodeSqliteDriver(path),
        wipe: () => wipeNodeMailbox(path),
        stash: { ...stash, clear: async () => undefined },
      });
      await store.close();
    }

    const driver = createNodeSqliteDriver(path);
    const counts = await driver.read((tx) =>
      tx.query(
        `SELECT
           (SELECT COUNT(*) FROM operations) AS operations,
           (SELECT COUNT(*) FROM operation_targets) AS targets,
           (SELECT COUNT(*) FROM drafts) AS drafts,
           (SELECT revision FROM drafts) AS revision`,
      ),
    );
    expect(counts[0]).toEqual({
      operations: 1,
      targets: 1,
      drafts: 1,
      revision: 1,
    });
    await driver.close();
  });

  it("rebuilds a file that is not a database", async () => {
    const path = await mailboxPath();
    await writeFile(path, "this is not sqlite ".repeat(512));
    const onRebuild = vi.fn();

    const store = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(path),
      wipe: () => wipeNodeMailbox(path),
      stash: memoryStash(),
      onRebuild,
    });

    expect(onRebuild).toHaveBeenCalledOnce();
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    await store.close();
  });

  it("leaves a mailbox held elsewhere untouched for the caller to retry", async () => {
    const path = await mailboxPath();
    await seedPendingWork(path);
    const wipe = vi.fn(async () => undefined);

    await expect(
      openMailStoreWithRecovery({
        open: async () =>
          failingWrites(
            createNodeSqliteDriver(path),
            Object.assign(new Error("database is locked"), { errcode: 5 }),
          ),
        wipe,
        stash: memoryStash(),
      }),
    ).rejects.toThrow("database is locked");

    expect(wipe).not.toHaveBeenCalled();
  });
});

async function mailboxPath() {
  const directory = await mkdtemp(join(tmpdir(), "mail-sqlite-recovery-"));
  directories.push(directory);
  return join(directory, "mailbox.sqlite");
}

async function seedPendingWork(path: string) {
  const driver = createNodeSqliteDriver(path);
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  await store.saveDraft({
    key: DRAFT,
    expectedRevision: null,
    content: {
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Plans",
      editableHtml: "<p>Thursday works.</p>",
      quotedHtml: "",
    },
  });
  await store.admitMetadata({
    accountId: "acc-1",
    commandId: "archive-1",
    targets: [{ accountId: "acc-1", messageId: "m1" }],
    change: { kind: "archive" },
  });
  await store.admitMetadata({
    accountId: "acc-1",
    commandId: "done-1",
    targets: [{ accountId: "acc-1", messageId: "m2" }],
    change: { kind: "set_read", read: true },
  });
  await driver.write((tx) =>
    tx.execute(
      "UPDATE operations SET status = 'succeeded' WHERE command_id = 'done-1'",
    ),
  );
  await store.close();
}

/** A mailbox whose migration fails: it still reads, but nothing commits. */
function failingWrites(
  driver: SqliteDriver,
  error: Error = Object.assign(new Error("database disk image is malformed"), {
    errcode: 11,
  }),
): SqliteDriver {
  return {
    read: (work) => driver.read(work),
    write: async () => {
      throw error;
    },
    close: () => driver.close(),
  };
}

function memoryStash(): PendingMailWorkStash {
  let stored: string | null = null;
  return {
    async read() {
      return stored ? (JSON.parse(stored) as PendingMailWork) : null;
    },
    async write(work) {
      stored = JSON.stringify(work);
    },
    async clear() {
      stored = null;
    },
  };
}

async function syncInbox(store: MailStore, messageIds: string[]) {
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "bootstrap",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: messageIds.map((messageId, index) =>
        inboxMessage(messageId, 1000 + index),
      ),
      requiredHydration: [],
      roundComplete: true,
    },
  });
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
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
