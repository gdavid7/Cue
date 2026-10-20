import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver, wipeNodeMailbox } from "./node-sqlite";
import { classifyMailboxError } from "./mailbox-errors";
import {
  openMailStoreWithRecovery,
  readPendingMailWork,
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

  it("reads an I/O error, which a full OPFS disk reports, as unavailable storage", () => {
    // SQLITE_IOERR_WRITE: the primary code 10 in the low byte.
    expect(
      classifyMailboxError(
        Object.assign(new Error("disk I/O error"), { resultCode: 778 }),
      ),
    ).toBe("unavailable");
    expect(
      classifyMailboxError(
        new Error(
          "SQLITE_IOERR_WRITE: sqlite3 result code 778: disk I/O error",
        ),
      ),
    ).toBe("unavailable");
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
      ownedAccountIds: ["acc-1"],
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
        ownedAccountIds: ["acc-1"],
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
        ownedAccountIds: ["acc-1"],
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

  it("drops carried work belonging to accounts the signed-in user does not own", async () => {
    // A rebuild still running when user A signed out left A's work behind.
    const previousUser = await pendingWorkFrom(await seededMailbox());
    const path = await mailboxPath();
    const stash = memoryStash();
    await stash.write(previousUser);

    const store = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(path),
      wipe: () => wipeNodeMailbox(path),
      stash,
      ownedAccountIds: ["acc-user-b"],
    });

    expect(await store.readDraft(DRAFT)).toMatchObject({ status: "missing" });
    expect(await stash.read()).toBeNull();
    await store.close();
    const driver = createNodeSqliteDriver(path);
    const rows = await driver.read((tx) =>
      tx.query(
        `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
                (SELECT COUNT(*) FROM operations) AS operations`,
      ),
    );
    expect(rows[0]).toEqual({ accounts: 0, operations: 0 });
    await driver.close();
  });

  it("opens a mailbox before the signed-in accounts are known, waiting for them only to carry work", async () => {
    const healthy = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(await mailboxPath()),
      wipe: async () => undefined,
      stash: memoryStash(),
      ownedAccountIds: new Promise(() => undefined),
    });
    await healthy.close();

    const stash = memoryStash();
    await stash.write(await pendingWorkFrom(await seededMailbox()));
    let nameOwned: (accountIds: string[]) => void = () => undefined;
    let opened = false;
    const opening = openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(await mailboxPath()),
      wipe: async () => undefined,
      stash,
      ownedAccountIds: new Promise((resolve) => {
        nameOwned = resolve;
      }),
    }).then((store) => {
      opened = true;
      return store;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(false);
    nameOwned(["acc-1"]);
    const store = await opening;
    expect(await store.readDraft(DRAFT)).toMatchObject({ status: "found" });
    await store.close();
  });

  it("closes a mailbox opened early when its host abandons it before naming the accounts", async () => {
    const stash = memoryStash();
    await stash.write(await pendingWorkFrom(await seededMailbox()));
    const path = await mailboxPath();
    const closed = vi.fn();
    let abandon: (error: Error) => void = () => undefined;

    const opening = openMailStoreWithRecovery({
      open: async () => {
        const driver = createNodeSqliteDriver(path);
        const close = driver.close.bind(driver);
        return Object.assign(driver, {
          close: async () => {
            closed();
            await close();
          },
        });
      },
      wipe: async () => undefined,
      stash,
      ownedAccountIds: new Promise((_, reject) => {
        abandon = reject;
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abandon(new Error("abandoned"));

    await expect(opening).rejects.toThrow("abandoned");
    expect(closed).toHaveBeenCalledOnce();
    // Nothing was carried, so the next open still has the work.
    expect(await stash.read()).not.toBeNull();
  });

  it("lets go of a mailbox held elsewhere at once, before the signed-in accounts are known", async () => {
    // A mailbox opened early keeps its files until it settles, so a held one
    // must not wait for an engine start that may never come.
    const stash = memoryStash();
    await stash.write(await pendingWorkFrom(await seededMailbox()));

    await expect(
      openMailStoreWithRecovery({
        open: async () =>
          failingWrites(
            createNodeSqliteDriver(await mailboxPath()),
            Object.assign(new Error("database is locked"), { errcode: 5 }),
          ),
        wipe: async () => undefined,
        stash,
        ownedAccountIds: new Promise(() => undefined),
      }),
    ).rejects.toThrow("database is locked");
    expect(await stash.read()).not.toBeNull();
  });

  it("reports carried rows it could not restore, without their content", async () => {
    const work = await pendingWorkFrom(await seededMailbox());
    const draft = work.drafts[0];
    const path = await mailboxPath();
    const stash = memoryStash();
    await stash.write({
      ...work,
      accounts: [
        ...work.accounts,
        { accountId: "acc-imap", provider: "imap", generation: "g1" },
      ],
      drafts: [
        { ...draft, draft_id: "d-damaged", content_json: null },
        { ...draft, account_id: "acc-other-user" },
      ],
    });
    const onDropped = vi.fn();

    const store = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(path),
      wipe: () => wipeNodeMailbox(path),
      stash,
      ownedAccountIds: ["acc-1", "acc-imap"],
      onDropped,
    });
    await store.close();

    expect(onDropped.mock.calls.map(([drop]) => drop)).toEqual(
      expect.arrayContaining([
        { table: "accounts", reason: "unsupported_provider", count: 1 },
        { table: "drafts", reason: "rejected", count: 1 },
        { table: "drafts", reason: "not_owned", count: 1 },
      ]),
    );
    expect(onDropped).toHaveBeenCalledTimes(3);
  });

  it("rebuilds a file that is not a database", async () => {
    const path = await mailboxPath();
    await writeFile(path, "this is not sqlite ".repeat(512));
    const onRebuild = vi.fn();

    const store = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(path),
      wipe: () => wipeNodeMailbox(path),
      stash: memoryStash(),
      ownedAccountIds: ["acc-1"],
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

  it.each([
    [
      "a full disk",
      Object.assign(new Error("disk I/O error"), { errcode: 778 }),
    ],
    ["a failed migration", new Error("migration 12 failed: no such column")],
    [
      "a missing capability",
      new Error("SQLite savepoints are required for mailbox migrations"),
    ],
    ["a wasm trap", new Error("RuntimeError: memory access out of bounds")],
  ])("keeps a healthy mailbox that fails to open after %s", async (_, error) => {
    const path = await mailboxPath();
    await seedPendingWork(path);
    const wipe = vi.fn(() => wipeNodeMailbox(path));
    const onRebuild = vi.fn();
    const stash = memoryStash();

    await expect(
      openMailStoreWithRecovery({
        open: async () => failingWrites(createNodeSqliteDriver(path), error),
        wipe,
        stash,
        ownedAccountIds: ["acc-1"],
        onRebuild,
      }),
    ).rejects.toBe(error);

    expect(wipe).not.toHaveBeenCalled();
    expect(onRebuild).not.toHaveBeenCalled();
    expect(await stash.read()).toBeNull();
    const store = await createSqliteMailStore(createNodeSqliteDriver(path));
    expect(await store.readDraft(DRAFT)).toMatchObject({ status: "found" });
    await store.close();
  });

  it.each([
    [
      "an I/O error",
      Object.assign(new Error("disk I/O error"), { resultCode: 266 }),
    ],
    [
      "an unrecognised migration error",
      new Error("SQLITE_ERROR: no such column: snoozed_until_ms"),
    ],
    ["a wasm trap", new Error("RuntimeError: unreachable")],
  ])("never wipes or touches the files when opening fails with %s", async (_, error) => {
    const path = await seededMailbox();
    const before = await readFile(path);
    const wipe = vi.fn(() => wipeNodeMailbox(path));

    for (const open of [
      async () => {
        throw error;
      },
      async () => failingWrites(createNodeSqliteDriver(path), error),
    ]) {
      await expect(
        openMailStoreWithRecovery({
          open,
          wipe,
          stash: memoryStash(),
          ownedAccountIds: ["acc-1"],
        }),
      ).rejects.toBe(error);
    }

    expect(wipe).not.toHaveBeenCalled();
    expect((await readFile(path)).equals(before)).toBe(true);
  });

  it("does not rebuild when the stash cannot be read", async () => {
    // Writing a new stash over one that failed to read would lose its work.
    const path = await seededMailbox();
    const wipe = vi.fn(() => wipeNodeMailbox(path));
    const readFailed = new Error("IndexedDB read failed");

    await expect(
      openMailStoreWithRecovery({
        open: corruptOnFirstOpen(path),
        wipe,
        stash: {
          ...memoryStash(),
          read: async () => {
            throw readFailed;
          },
        },
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toBe(readFailed);

    expect(wipe).not.toHaveBeenCalled();
  });

  it("does not rebuild when the stash read rejects without an error", async () => {
    // IndexedDB can reject with a null transaction.error.
    const path = await seededMailbox();
    const wipe = vi.fn(() => wipeNodeMailbox(path));

    await expect(
      openMailStoreWithRecovery({
        open: corruptOnFirstOpen(path),
        wipe,
        stash: {
          ...memoryStash(),
          read: () => Promise.reject(undefined),
        },
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toThrow();

    expect(wipe).not.toHaveBeenCalled();
  });

  it("does not rebuild when the damaged mailbox fails to read for another reason", async () => {
    const path = await seededMailbox();
    const wipe = vi.fn(() => wipeNodeMailbox(path));
    const outOfMemory = new Error("out of memory");

    await expect(
      openMailStoreWithRecovery({
        open: async () =>
          failingReads(
            failingWrites(createNodeSqliteDriver(path)),
            "FROM drafts",
            outOfMemory,
          ),
        wipe,
        stash: memoryStash(),
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toBe(outOfMemory);

    expect(wipe).not.toHaveBeenCalled();
  });

  it.each([
    ["setting up", "INTO schema_migrations"],
    ["restoring work into", "INTO accounts"],
  ])("closes the rebuilt mailbox when %s it fails, keeping the stash", async (_, failingSql) => {
    const path = await seededMailbox();
    const stash = memoryStash();
    const closes = vi.fn();
    const failure = new Error("restore failed");
    let opens = 0;

    await expect(
      openMailStoreWithRecovery({
        open: async () => {
          opens += 1;
          const driver = createNodeSqliteDriver(path);
          if (opens === 1) return failingWrites(driver);
          return {
            ...failingWriteSql(driver, failingSql, failure),
            close: async () => {
              closes();
              await driver.close();
            },
          };
        },
        wipe: () => wipeNodeMailbox(path),
        stash,
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toBe(failure);

    expect(closes).toHaveBeenCalled();
    expect((await stash.read())?.drafts).toHaveLength(1);
  });

  it("retries clearing the stash before giving up on the open", async () => {
    const path = await seededMailbox();
    const stash = memoryStash();
    let clears = 0;

    const store = await openMailStoreWithRecovery({
      open: corruptOnFirstOpen(path),
      wipe: () => wipeNodeMailbox(path),
      stash: {
        ...stash,
        clear: async () => {
          clears += 1;
          if (clears < 3) throw new Error("transaction aborted");
          await stash.clear();
        },
      },
      ownedAccountIds: ["acc-1"],
    });

    expect(await stash.read()).toBeNull();
    expect(await store.readDraft(DRAFT)).toMatchObject({ status: "found" });
    await store.close();
  });

  it("leaves a corrupt mailbox in place when its unsent work cannot be stashed", async () => {
    const path = await seededMailbox();
    const wipe = vi.fn(() => wipeNodeMailbox(path));
    const stashFull = new DOMException("quota exceeded", "QuotaExceededError");

    await expect(
      openMailStoreWithRecovery({
        open: async () => failingWrites(createNodeSqliteDriver(path)),
        wipe,
        stash: {
          ...memoryStash(),
          write: async () => {
            throw stashFull;
          },
        },
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toBe(stashFull);

    expect(wipe).not.toHaveBeenCalled();
    expect((await pendingWorkFrom(path)).drafts).toHaveLength(1);
  });

  it("does not hand out a mailbox whose restored work is still stashed", async () => {
    // Left in the stash, the work would be restored again on a later open,
    // after the engine had sent the draft or finished the command.
    const path = await seededMailbox();
    const stash = memoryStash();
    const clearFailed = new Error("stash clear failed");

    await expect(
      openMailStoreWithRecovery({
        open: corruptOnFirstOpen(path),
        wipe: () => wipeNodeMailbox(path),
        stash: {
          ...stash,
          clear: async () => {
            throw clearFailed;
          },
        },
        ownedAccountIds: ["acc-1"],
      }),
    ).rejects.toBe(clearFailed);

    const store = await openMailStoreWithRecovery({
      open: async () => createNodeSqliteDriver(path),
      wipe: () => wipeNodeMailbox(path),
      stash,
      ownedAccountIds: ["acc-1"],
    });
    expect(await stash.read()).toBeNull();
    expect(await store.readDraft(DRAFT)).toMatchObject({ status: "found" });
    await store.close();
  });

  it("keeps the newest copy of carried work when a stale stash meets the mailbox", async () => {
    const path = await mailboxPath();
    const stale = await seedThenAdvance(path);
    const stash = memoryStash();
    await stash.write(stale);
    let opens = 0;

    const store = await openMailStoreWithRecovery({
      open: async () => {
        opens += 1;
        const driver = createNodeSqliteDriver(path);
        return opens === 1 ? failingWrites(driver) : driver;
      },
      wipe: () => wipeNodeMailbox(path),
      stash,
      ownedAccountIds: ["acc-1"],
    });

    expect(await store.readDraft(DRAFT)).toMatchObject({
      status: "found",
      draftRevision: 2,
      content: { editableHtml: "<p>Friday works.</p>" },
    });
    // done-1 succeeded after the stash was written; it must not run again.
    const finished = await store.readOperation({
      accountId: "acc-1",
      operationId: "done-1",
    });
    expect(finished.operation).toBeNull();
    await store.close();
    const driver = createNodeSqliteDriver(path);
    const [counts] = await driver.read((tx) =>
      tx.query(
        `SELECT (SELECT COUNT(*) FROM operations) AS operations,
                (SELECT COUNT(*) FROM operation_targets) AS targets`,
      ),
    );
    expect(counts).toEqual({ operations: 1, targets: 1 });
    await driver.close();
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
        ownedAccountIds: ["acc-1"],
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

async function seededMailbox() {
  const path = await mailboxPath();
  await seedPendingWork(path);
  return path;
}

async function pendingWorkFrom(path: string) {
  const driver = createNodeSqliteDriver(path);
  const work = await readPendingMailWork(driver);
  await driver.close();
  return work;
}

/**
 * Seeds pending work and returns a snapshot of it, then moves the mailbox on:
 * the draft is saved again and done-1 succeeds.
 */
async function seedThenAdvance(path: string) {
  const driver = createNodeSqliteDriver(path);
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const content = {
    to: ["ada@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: Plans",
    editableHtml: "<p>Thursday works.</p>",
    quotedHtml: "",
  };
  await store.saveDraft({ key: DRAFT, expectedRevision: null, content });
  for (const commandId of ["archive-1", "done-1"]) {
    await store.admitMetadata({
      accountId: "acc-1",
      commandId,
      targets: [{ accountId: "acc-1", messageId: `m-${commandId}` }],
      change: { kind: "archive" },
    });
  }
  const snapshot = await readPendingMailWork(driver);
  await store.saveDraft({
    key: DRAFT,
    expectedRevision: 1,
    content: { ...content, editableHtml: "<p>Friday works.</p>" },
  });
  await driver.write((tx) =>
    tx.execute(
      "UPDATE operations SET status = 'succeeded' WHERE command_id = 'done-1'",
    ),
  );
  await store.close();
  return snapshot;
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

function failingReads(
  driver: SqliteDriver,
  sqlFragment: string,
  error: Error,
): SqliteDriver {
  return {
    ...driver,
    read: (work) =>
      driver.read((tx) =>
        work({
          ...tx,
          query: async (sql, bindings) => {
            if (sql.includes(sqlFragment)) throw error;
            return tx.query(sql, bindings);
          },
        }),
      ),
  };
}

function failingWriteSql(
  driver: SqliteDriver,
  sqlFragment: string,
  error: Error,
): SqliteDriver {
  return {
    ...driver,
    write: (work) =>
      driver.write((tx) =>
        work({
          ...tx,
          execute: async (sql, bindings) => {
            if (sql.includes(sqlFragment)) throw error;
            return tx.execute(sql, bindings);
          },
        }),
      ),
  };
}

function corruptOnFirstOpen(path: string) {
  let opens = 0;
  return async () => {
    opens += 1;
    const driver = createNodeSqliteDriver(path);
    return opens === 1 ? failingWrites(driver) : driver;
  };
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
