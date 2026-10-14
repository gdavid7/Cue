import initSqlite, { type Database } from "@sqlite.org/sqlite-wasm";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type {
  SqlTransaction,
  SqlValue,
  SqliteDriver,
} from "@inboxzero/mail-sqlite/driver";
import { openMailStoreWithRecovery } from "@inboxzero/mail-sqlite/recovery";
import {
  createSqliteMailStore,
  type SqliteMailStoreOptions,
} from "@inboxzero/mail-sqlite/store";
import { createMailRecoveryStash } from "@/utils/mail-engine/recovery-stash";

export const MAIL_ENGINE_OPFS_DIRECTORY = ".mail-engine";
// Held while a context has the mailbox files open. The browser releases it
// when that context dies, so whoever holds it is alive.
const MAILBOX_FILES_LOCK = "inbox-zero:mailbox-files";
const MAILBOX_FILES_LOCK_WAIT_MS = 10_000;
const MAILBOX_PATH = "/mailbox.sqlite";

export async function createWasmSqliteDriver(input?: {
  name?: string;
  persist?: boolean;
}): Promise<SqliteDriver> {
  const sqlite = await initSqlite();
  if (!canPersist(input?.persist)) return createMemoryDriver(sqlite);
  const pool = await sqlite.installOpfsSAHPoolVfs({
    name: input?.name ?? "mail-engine",
    directory: MAIL_ENGINE_OPFS_DIRECTORY,
    initialCapacity: 8,
  });
  await pool.unpauseVfs();
  const database = new pool.OpfsSAHPoolDb(MAILBOX_PATH);
  return createDatabaseDriver(database, async () => {
    database.close();
    await pool.pauseVfs();
  });
}

/**
 * Opens the mailbox store on OPFS once no live context holds its files, and
 * rebuilds a corrupt mailbox while keeping the user's unsent work.
 */
export async function createWasmMailStore(input: {
  persist?: boolean;
  ownedAccountIds: string[];
  options?: SqliteMailStoreOptions;
  onRebuild?: () => void;
}): Promise<MailStore> {
  const sqlite = await initSqlite();
  if (!canPersist(input.persist)) {
    return createSqliteMailStore(createMemoryDriver(sqlite), input.options);
  }
  const releaseFiles = await holdMailboxFiles();
  try {
    const pool = await sqlite.installOpfsSAHPoolVfs({
      name: "mail-engine",
      directory: MAIL_ENGINE_OPFS_DIRECTORY,
      initialCapacity: 8,
    });
    const store = await openMailStoreWithRecovery({
      async open() {
        if (pool.isPaused()) await pool.unpauseVfs();
        const database = new pool.OpfsSAHPoolDb(MAILBOX_PATH);
        const release = async () => {
          database.close();
          pool.pauseVfs();
        };
        try {
          return createDatabaseDriver(database, release);
        } catch (error) {
          // The pool cannot wipe the files for a rebuild while this is open.
          await release();
          throw error;
        }
      },
      async wipe() {
        if (pool.isPaused()) await pool.unpauseVfs();
        await pool.wipeFiles();
      },
      stash: createMailRecoveryStash(),
      ownedAccountIds: input.ownedAccountIds,
      options: input.options,
      onRebuild: input.onRebuild,
    });
    const closeStore = store.close.bind(store);
    return Object.assign(store, {
      async close() {
        try {
          await closeStore();
        } finally {
          releaseFiles();
        }
      },
    });
  } catch (error) {
    releaseFiles();
    throw error;
  }
}

/** Resolves false when the mailbox is still on disk after every retry. */
export async function wipeOpfsMailEngine(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !("storage" in navigator) ||
    !("getDirectory" in navigator.storage)
  ) {
    return true;
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    // Without OPFS access the engine could not have stored anything either.
    return true;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await root.removeEntry(MAIL_ENGINE_OPFS_DIRECTORY, { recursive: true });
      return true;
    } catch (error) {
      if (isMissingOpfsEntry(error)) return true;
      if (attempt === 7) return false;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  return false;
}

function canPersist(persist: boolean | undefined) {
  return (
    persist !== false &&
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    "getDirectory" in navigator.storage
  );
}

function createMemoryDriver(sqlite: Awaited<ReturnType<typeof initSqlite>>) {
  const database = new sqlite.oo1.DB(":memory:");
  return createDatabaseDriver(database, async () => {
    database.close();
  });
}

function createDatabaseDriver(
  database: Database,
  release: () => Promise<void>,
): SqliteDriver {
  database.exec("PRAGMA foreign_keys=ON");
  let chain = Promise.resolve();
  let closed = false;

  function runExclusive<T>(
    work: (tx: SqlTransaction) => Promise<T>,
    write: boolean,
  ) {
    if (closed) return Promise.reject(new Error("sqlite driver is closed"));
    const run = chain.then(async () => {
      database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      const tx = createTransaction(database);
      try {
        const result = await work(tx);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    read: (work) => runExclusive(work, false),
    write: (work) => runExclusive(work, true),
    async close() {
      if (closed) return;
      closed = true;
      await chain;
      await release();
    },
  };
}

/**
 * Waits for the live context holding the mailbox files to let go. A busy
 * error after this comes from a dead context's handles, which clear on retry.
 */
function holdMailboxFiles(): Promise<() => void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) return Promise.resolve(() => undefined);
  return new Promise((resolve, reject) => {
    locks
      .request(
        MAILBOX_FILES_LOCK,
        { signal: AbortSignal.timeout(MAILBOX_FILES_LOCK_WAIT_MS) },
        () =>
          new Promise<void>((release) => {
            resolve(release);
          }),
      )
      .catch(() => reject(new Error("mailbox is in use by another tab")));
  });
}

function createTransaction(database: Database): SqlTransaction {
  return {
    async exec(sql) {
      database.exec(sql);
    },
    async query(sql, bindings = []) {
      const rows = database.exec({
        sql,
        bind: bindings as never,
        rowMode: "object",
        returnValue: "resultRows",
      }) as Array<Record<string, SqlValue>>;
      return rows ?? [];
    },
    async execute(sql, bindings = []) {
      database.exec({
        sql,
        bind: bindings as never,
      });
      const changed = Number(database.selectValue("SELECT changes()") ?? 0);
      return { changedRows: changed };
    },
  };
}

function isMissingOpfsEntry(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotFoundError"
  );
}
