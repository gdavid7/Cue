import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { SqlRow, SqlTransaction, SqliteDriver } from "./driver";
import { createSqliteMailStore, type SqliteMailStoreOptions } from "./store";

/**
 * Why a mailbox could not be opened: `busy` clears once another holder lets
 * go of the files, `corrupt` needs a rebuild, `unavailable` means storage
 * cannot hold the mailbox right now (no OPFS, a full disk, an I/O error).
 */
export type MailboxOpenFailure = "corrupt" | "busy" | "unavailable";

/** The user's unsent work, kept outside the mailbox while it is rebuilt. */
export type PendingMailWork = {
  accounts: Array<{ accountId: string; provider: string; generation: string }>;
  drafts: SqlRow[];
  operations: SqlRow[];
  operationTargets: SqlRow[];
  operationConversations: SqlRow[];
};

/** Holds pending work across a rebuild, surviving a reload in the middle. */
export type PendingMailWorkStash = {
  read(): Promise<PendingMailWork | null>;
  write(work: PendingMailWork): Promise<void>;
  clear(): Promise<void>;
};

export class MailboxCorruptError extends Error {
  constructor(message: string) {
    super(`SQLITE_CORRUPT: ${message}`);
    this.name = "MailboxCorruptError";
  }
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

// Checked on every open: these hold the work a rebuild must carry over, and
// they are small, unlike a full integrity check of every message.
const PRESERVED_TABLES = [
  "accounts",
  "drafts",
  "operations",
  "operation_targets",
  "operation_conversations",
];

const OPERATION_COLUMNS = [
  "account_id",
  "command_id",
  "status",
  "authority",
  "intent_hash",
  "executable_hash",
  "payload_json",
  "executable_payload_json",
  "attempts",
  "next_attempt_at_ms",
  "error_code",
  "error_retryable",
  "receipt_id",
  "resolution_id",
  "created_at_ms",
  "sent_message_id",
];
const DRAFT_COLUMNS = [
  "account_id",
  "draft_id",
  "revision",
  "content_json",
  "frozen",
  "updated_at_ms",
];
const TARGET_COLUMNS = [
  "account_id",
  "command_id",
  "message_id",
  "conversation_id",
  "outcome",
  "code",
];
const CONVERSATION_COLUMNS = [
  "account_id",
  "command_id",
  "conversation_id",
  "resolution_id",
  "next_page",
  "complete",
];
const FINISHED_OPERATION_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
];

/**
 * Classifies by result code and message text, since errors crossing a worker
 * boundary arrive as text.
 */
export function classifyMailboxError(
  error: unknown,
): MailboxOpenFailure | null {
  const code = readResultCode(error);
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return "corrupt";
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return "busy";
  // The OPFS SAH-pool VFS reports a full disk as an I/O error, not FULL.
  if (code === SQLITE_FULL || code === SQLITE_IOERR) return "unavailable";
  const text = errorText(error);
  if (
    text.includes("sqlite_corrupt") ||
    text.includes("sqlite_notadb") ||
    text.includes("database disk image is malformed") ||
    text.includes("not a database")
  ) {
    return "corrupt";
  }
  if (
    text.includes("sqlite_busy") ||
    text.includes("sqlite_locked") ||
    text.includes("database is locked") ||
    text.includes("nomodificationallowederror") ||
    text.includes("access handle") ||
    text.includes("timeouterror") ||
    text.includes("mailbox is in use")
  ) {
    return "busy";
  }
  if (
    text.includes("quotaexceedederror") ||
    text.includes("quota") ||
    text.includes("sqlite_full") ||
    text.includes("disk is full") ||
    text.includes("sqlite_ioerr") ||
    text.includes("disk i/o error") ||
    text.includes("securityerror")
  ) {
    return "unavailable";
  }
  return null;
}

/**
 * Opens the mailbox store. Only a mailbox SQLite reports as corrupt is
 * rebuilt empty for a fresh sync, with the user's drafts and unsent commands
 * carried over through `stash` so a reload mid-rebuild loses nothing. Every
 * other failure (a held or full disk, a failed migration, a wasm trap) is
 * thrown with the mailbox untouched: wiping on those would resync every
 * affected mailbox from scratch and still fail the same way.
 */
export async function openMailStoreWithRecovery(input: {
  open: () => Promise<SqliteDriver>;
  /** Deletes the mailbox files; called with no connection open. */
  wipe: () => Promise<void>;
  stash: PendingMailWorkStash;
  /**
   * The signed-in user's accounts. The stash outlives sign-out when a rebuild
   * was still running, so work for any other account is dropped, never
   * admitted into this user's mailbox.
   */
  ownedAccountIds: readonly string[];
  options?: SqliteMailStoreOptions;
  onRebuild?: () => void;
}): Promise<MailStore> {
  const stashed = await input.stash.read().catch(() => null);
  let carried = stashed && ownedWork(stashed, input.ownedAccountIds);
  let opened: { driver: SqliteDriver; store: MailStore } | null = null;
  let failure: unknown = null;
  let driver: SqliteDriver | null = null;
  try {
    driver = await input.open();
    opened = { driver, store: await openCheckedStore(driver, input.options) };
  } catch (error) {
    failure = error;
  }
  if (!opened) {
    if (classifyMailboxError(failure) !== "corrupt") {
      await driver?.close().catch(() => undefined);
      throw failure;
    }
    input.onRebuild?.();
    if (driver) {
      carried = mergePendingWork(
        carried,
        ownedWork(await readPendingMailWork(driver), input.ownedAccountIds),
      );
      await driver.close().catch(() => undefined);
    }
    // Written before the wipe so the work outlives a reload mid-rebuild.
    if (carried) await input.stash.write(carried).catch(() => undefined);
    await input.wipe();
    const fresh = await input.open();
    opened = {
      driver: fresh,
      store: await createSqliteMailStore(fresh, input.options),
    };
  }
  if (carried) {
    await restorePendingMailWork(opened.store, opened.driver, carried);
  }
  if (carried || stashed) await input.stash.clear().catch(() => undefined);
  return opened.store;
}

/** Best effort: whatever still reads from a damaged mailbox is kept. */
export async function readPendingMailWork(
  driver: SqliteDriver,
): Promise<PendingMailWork> {
  const finished = FINISHED_OPERATION_STATUSES.map((status) => `'${status}'`);
  const pendingCommands = `SELECT account_id, command_id FROM operations WHERE status NOT IN (${finished.join(",")})`;
  const [accounts, drafts, operations, targets, conversations] =
    await Promise.all([
      readRows(driver, "SELECT account_id, provider, generation FROM accounts"),
      readRows(driver, "SELECT * FROM drafts"),
      readRows(
        driver,
        `SELECT * FROM operations WHERE status NOT IN (${finished.join(",")})`,
      ),
      readRows(
        driver,
        `SELECT * FROM operation_targets WHERE (account_id, command_id) IN (${pendingCommands})`,
      ),
      readRows(
        driver,
        `SELECT * FROM operation_conversations WHERE (account_id, command_id) IN (${pendingCommands})`,
      ),
    ]);
  return {
    accounts: accounts.map((row) => ({
      accountId: String(row.account_id),
      provider: String(row.provider),
      generation: String(row.generation),
    })),
    drafts: drafts.map((row) => pick(row, DRAFT_COLUMNS)),
    operations: operations.map((row) => pick(row, OPERATION_COLUMNS)),
    operationTargets: targets.map((row) => pick(row, TARGET_COLUMNS)),
    operationConversations: conversations.map((row) =>
      pick(row, CONVERSATION_COLUMNS),
    ),
  };
}

/**
 * Re-admits carried work into a freshly opened mailbox. Rows already present
 * are left alone, so restoring the same work twice admits it once.
 */
export async function restorePendingMailWork(
  store: MailStore,
  driver: SqliteDriver,
  work: PendingMailWork,
): Promise<void> {
  for (const account of work.accounts) {
    if (account.provider !== "google" && account.provider !== "microsoft") {
      continue;
    }
    const existing = await driver.read((tx) =>
      tx.query("SELECT 1 FROM accounts WHERE account_id = ?", [
        account.accountId,
      ]),
    );
    if (existing.length > 0) continue;
    await store.ensureAccount({
      accountId: account.accountId,
      provider: account.provider,
      generation: account.generation,
    });
  }
  await driver.write(async (tx) => {
    for (const row of work.drafts) {
      await insertIgnoring(tx, "drafts", DRAFT_COLUMNS, row);
    }
    for (const row of work.operations) {
      await insertIgnoring(tx, "operations", OPERATION_COLUMNS, {
        ...row,
        // The rebuilt mailbox has not seen the account connect yet, and a
        // ready connection is what would release a blocked command.
        status: row.status === "blocked_auth" ? "retry_wait" : row.status,
      });
    }
    for (const row of work.operationTargets) {
      await insertIgnoring(tx, "operation_targets", TARGET_COLUMNS, row);
    }
    for (const row of work.operationConversations) {
      await insertIgnoring(
        tx,
        "operation_conversations",
        CONVERSATION_COLUMNS,
        row,
      );
    }
  });
}

async function openCheckedStore(
  driver: SqliteDriver,
  options: SqliteMailStoreOptions | undefined,
) {
  const store = await createSqliteMailStore(driver, options);
  await driver.read(async (tx) => {
    for (const table of PRESERVED_TABLES) {
      const rows = await tx.query(`PRAGMA quick_check(${table})`);
      const result = rows.map((row) => Object.values(row)[0]).join("; ");
      if (result !== "ok") throw new MailboxCorruptError(result);
    }
  });
  return store;
}

async function readRows(driver: SqliteDriver, sql: string) {
  try {
    return await driver.read((tx) => tx.query(sql));
  } catch {
    return [];
  }
}

async function insertIgnoring(
  tx: SqlTransaction,
  table: string,
  columns: string[],
  row: SqlRow,
) {
  try {
    await tx.execute(
      `INSERT OR IGNORE INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => row[column] ?? null),
    );
  } catch {
    // A row damaged past its constraints is dropped rather than blocking
    // the rest of the user's work.
  }
}

function mergePendingWork(
  earlier: PendingMailWork | null,
  later: PendingMailWork,
): PendingMailWork | null {
  const merged = earlier
    ? {
        accounts: [...earlier.accounts, ...later.accounts],
        drafts: [...earlier.drafts, ...later.drafts],
        operations: [...earlier.operations, ...later.operations],
        operationTargets: [
          ...earlier.operationTargets,
          ...later.operationTargets,
        ],
        operationConversations: [
          ...earlier.operationConversations,
          ...later.operationConversations,
        ],
      }
    : later;
  const empty =
    merged.accounts.length === 0 &&
    merged.drafts.length === 0 &&
    merged.operations.length === 0;
  return empty ? null : merged;
}

function ownedWork(
  work: PendingMailWork,
  ownedAccountIds: readonly string[],
): PendingMailWork {
  const owned = new Set(ownedAccountIds);
  const ownedRow = (row: SqlRow) => owned.has(String(row.account_id));
  return {
    accounts: work.accounts.filter((account) => owned.has(account.accountId)),
    drafts: work.drafts.filter(ownedRow),
    operations: work.operations.filter(ownedRow),
    operationTargets: work.operationTargets.filter(ownedRow),
    operationConversations: work.operationConversations.filter(ownedRow),
  };
}

function pick(row: SqlRow, columns: string[]): SqlRow {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function readResultCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  for (const field of ["resultCode", "errcode"]) {
    if (field in error) {
      const value = Number((error as Record<string, unknown>)[field]);
      // Extended result codes keep the primary code in the low byte.
      if (Number.isFinite(value)) return value & 0xff;
    }
  }
  return null;
}

function errorText(error: unknown) {
  if (error instanceof Error || (error && typeof error === "object")) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return `${String(name ?? "")}: ${String(message ?? "")}`.toLowerCase();
  }
  return String(error).toLowerCase();
}
