import initSqlite, { type Database } from "@sqlite.org/sqlite-wasm";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type {
  SqlTransaction,
  SqlValue,
  SqliteDriver,
} from "@inboxzero/mail-sqlite/driver";
import { MailboxUnavailableError } from "@inboxzero/mail-sqlite/mailbox-errors";
import {
  openMailStoreWithRecovery,
  type DroppedMailWork,
} from "@inboxzero/mail-sqlite/recovery";
import {
  createSqliteMailStore,
  type SqliteMailStoreOptions,
} from "@inboxzero/mail-sqlite/store";
import { MAIL_ENGINE_OPFS_DIRECTORY } from "@/utils/mail-engine/opfs-mailbox";
import { createMailRecoveryStash } from "@/utils/mail-engine/recovery-stash";

// Held while a context has the mailbox files open. The browser releases it
// when that context dies, so whoever holds it is alive.
const MAILBOX_FILES_LOCK = "inbox-zero:mailbox-files";
const MAILBOX_FILES_LOCK_WAIT_MS = 10_000;
const MAILBOX_PATH = "/mailbox.sqlite";
/**
 * sqlite-wasm caches a failed pool install for the whole context, so Retry
 * in the same tab would fail without trying. Re-initializing is safe because
 * the patched sqlite-wasm only releases handles when an install fails.
 */
export const MAIL_ENGINE_SAH_POOL_RETRY = {
  forceReinitIfPreviouslyFailed: true,
};

/** An in-memory mailbox database, for hosts that cannot persist one. */
export async function createWasmMemoryDriver(): Promise<SqliteDriver> {
  return createMemoryDriver(await initSqlite());
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
  onDropped?: (drop: DroppedMailWork) => void;
}): Promise<MailStore> {
  const sqlite = await initSqlite();
  if (!canPersist(input.persist)) {
    return createSqliteMailStore(createMemoryDriver(sqlite), input.options);
  }
  const releaseFiles = await holdMailboxFiles();
  try {
    const pool = await sqlite
      .installOpfsSAHPoolVfs({
        name: "mail-engine",
        directory: MAIL_ENGINE_OPFS_DIRECTORY,
        initialCapacity: 8,
        ...MAIL_ENGINE_SAH_POOL_RETRY,
      })
      .catch((error: unknown) => {
        // A file a closing context still holds clears on retry; any other
        // handle failure will not, and the files are left for a later visit.
        if (isHeldFileError(error)) throw error;
        throw new MailboxUnavailableError(error);
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
          // Each archive or star commits a transaction. Keeping the rollback
          // journal between them, instead of creating and deleting a pool
          // file for every one, saves the pool's header writes and flushes.
          // A kept journal never shrinks on its own, so a large write's
          // journal is truncated back to this size after it commits.
          database.exec("PRAGMA journal_mode=PERSIST");
          database.exec("PRAGMA journal_size_limit=1048576");
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
      onDropped: input.onDropped,
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

function isHeldFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NoModificationAllowedError"
  );
}
