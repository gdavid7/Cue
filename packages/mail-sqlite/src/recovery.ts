import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { SqlRow, SqlTransaction, SqliteDriver } from "./driver";
import { createSqliteMailStore, type SqliteMailStoreOptions } from "./store";
import { classifyMailboxError, MailboxCorruptError } from "./mailbox-errors";

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

/**
 * Carried rows a restore left out, counted per table. Holds no row content,
 * so it is safe to log.
 */
export type DroppedMailWork = {
  table: string;
  reason: "not_owned" | "unsupported_provider" | "rejected";
  count: number;
};

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
// A failed IndexedDB transaction is often transient; failing the open over
// it would leave the user on the retry screen.
const STASH_CLEAR_RETRY_DELAYS_MS = [50, 250, 1000];
const FINISHED_OPERATION_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
];

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
   * admitted into this user's mailbox. A host can open the mailbox before it
   * knows them: they are awaited only when there is work to carry, before
   * any of it is read or `onRebuild` runs.
   */
  ownedAccountIds: readonly string[] | Promise<readonly string[]>;
  options?: SqliteMailStoreOptions;
  onRebuild?: () => void;
  onDropped?: (drop: DroppedMailWork) => void;
}): Promise<MailStore> {
  const drops = createDropCounter();
  let stashReadFailed = false;
  let stashReadError: unknown;
  const stashed = await input.stash.read().catch((error: unknown) => {
    stashReadFailed = true;
    stashReadError = error;
    return null;
  });
  let opened: { driver: SqliteDriver; store: MailStore } | null = null;
  let failure: unknown = null;
  let driver: SqliteDriver | null = null;
  try {
    driver = await input.open();
    opened = { driver, store: await openCheckedStore(driver, input.options) };
  } catch (error) {
    failure = error;
  }
  if (!opened && classifyMailboxError(failure) !== "corrupt") {
    await driver?.close().catch(() => undefined);
    throw failure;
  }
  let carried =
    stashed && ownedWork(stashed, await input.ownedAccountIds, drops);
  if (!opened) {
    // A stash that could not be read may hold earlier work that the write
    // below would replace.
    if (stashReadFailed) {
      await driver?.close().catch(() => undefined);
      throw stashReadError ?? new Error("recovery stash could not be read");
    }
    const ownedAccountIds = await input.ownedAccountIds;
    input.onRebuild?.();
    if (driver) {
      const damaged = driver;
      const [current, settled] = await Promise.all([
        readPendingMailWork(damaged),
        readSettledCommandKeys(damaged),
      ]).finally(() => damaged.close().catch(() => undefined));
      carried = mergePendingWork(
        carried,
        ownedWork(current, ownedAccountIds, drops),
        settled,
      );
    }
    // Written before the wipe so the work outlives a reload mid-rebuild; a
    // mailbox whose work cannot be kept aside is left as it is.
    if (carried) await input.stash.write(carried);
    await input.wipe();
    opened = await openFreshStore(input.open, input.options);
  }
  try {
    if (carried) {
      await restorePendingMailWork(opened.store, opened.driver, carried, drops);
    }
    for (const drop of drops.list()) input.onDropped?.(drop);
    // Work left in the stash would be restored again on a later open, after
    // the engine sent the draft or finished the command.
    if (carried || stashed) await clearWithRetries(input.stash);
  } catch (error) {
    // The stash still holds the work, so the next open restores it.
    await opened.store.close().catch(() => undefined);
    throw error;
  }
  return opened.store;
}

async function openFreshStore(
  open: () => Promise<SqliteDriver>,
  options: SqliteMailStoreOptions | undefined,
) {
  const driver = await open();
  try {
    return { driver, store: await createSqliteMailStore(driver, options) };
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw error;
  }
}

async function clearWithRetries(stash: PendingMailWorkStash) {
  for (let attempt = 0; ; attempt++) {
    try {
      await stash.clear();
      return;
    } catch (error) {
      const retryInMs = STASH_CLEAR_RETRY_DELAYS_MS[attempt];
      if (retryInMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
}

/** Whatever still reads from a damaged mailbox is kept. */
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
async function restorePendingMailWork(
  store: MailStore,
  driver: SqliteDriver,
  work: PendingMailWork,
  drops: DropCounter,
): Promise<void> {
  for (const account of work.accounts) {
    if (account.provider !== "google" && account.provider !== "microsoft") {
      drops.add("accounts", "unsupported_provider");
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
      await insertIgnoring(tx, "drafts", DRAFT_COLUMNS, row, drops);
    }
    for (const row of work.operations) {
      await insertIgnoring(
        tx,
        "operations",
        OPERATION_COLUMNS,
        {
          ...row,
          // The rebuilt mailbox has not seen the account connect yet, and a
          // ready connection is what would release a blocked command.
          status: row.status === "blocked_auth" ? "retry_wait" : row.status,
        },
        drops,
      );
    }
    for (const row of work.operationTargets) {
      await insertIgnoring(tx, "operation_targets", TARGET_COLUMNS, row, drops);
    }
    for (const row of work.operationConversations) {
      await insertIgnoring(
        tx,
        "operation_conversations",
        CONVERSATION_COLUMNS,
        row,
        drops,
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
  } catch (error) {
    // Damage is expected here; anything else stops the rebuild before the
    // wipe, since the work it would have read would be lost.
    if (classifyMailboxError(error) === "corrupt") return [];
    throw error;
  }
}

async function insertIgnoring(
  tx: SqlTransaction,
  table: string,
  columns: string[],
  row: SqlRow,
  drops: DropCounter,
) {
  try {
    // Only a row already present is skipped; any other constraint failure
    // throws, so the drop is counted.
    await tx.execute(
      `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
      columns.map((column) => row[column] ?? null),
    );
  } catch {
    // A row damaged past its constraints is dropped rather than blocking
    // the rest of the user's work.
    drops.add(table, "rejected");
  }
}

/**
 * Merges work stashed by an earlier rebuild with what the mailbox holds now.
 * The mailbox's copy is newer: a draft keeps its highest revision, and a
 * command the mailbox has since settled is not carried again.
 */
function mergePendingWork(
  earlier: PendingMailWork | null,
  later: PendingMailWork,
  settledCommands: Set<string>,
): PendingMailWork | null {
  let merged = later;
  if (earlier) {
    const operations = latestByKey(
      [
        ...earlier.operations.filter(
          (row) => !settledCommands.has(commandKey(row)),
        ),
        ...later.operations,
      ],
      commandKey,
    );
    const kept = new Set(operations.map(commandKey));
    const ofKeptCommand = (row: SqlRow) => kept.has(commandKey(row));
    merged = {
      accounts: latestByKey(
        [...earlier.accounts, ...later.accounts],
        (account) => account.accountId,
      ),
      drafts: highestDraftRevisions([...earlier.drafts, ...later.drafts]),
      operations,
      operationTargets: latestByKey(
        [...earlier.operationTargets, ...later.operationTargets],
        (row) => `${commandKey(row)}\u0000${String(row.message_id)}`,
      ).filter(ofKeptCommand),
      operationConversations: latestByKey(
        [...earlier.operationConversations, ...later.operationConversations],
        (row) => `${commandKey(row)}\u0000${String(row.conversation_id)}`,
      ).filter(ofKeptCommand),
    };
  }
  const empty =
    merged.accounts.length === 0 &&
    merged.drafts.length === 0 &&
    merged.operations.length === 0;
  return empty ? null : merged;
}

async function readSettledCommandKeys(driver: SqliteDriver) {
  const finished = FINISHED_OPERATION_STATUSES.map((status) => `'${status}'`);
  const rows = await readRows(
    driver,
    `SELECT account_id, command_id FROM operations WHERE status IN (${finished.join(",")})`,
  );
  return new Set(rows.map(commandKey));
}

function commandKey(row: SqlRow) {
  return `${String(row.account_id)}\u0000${String(row.command_id)}`;
}

/** Later rows replace earlier ones with the same key. */
function latestByKey<T>(rows: T[], keyOf: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [keyOf(row), row])).values()];
}

function highestDraftRevisions(drafts: SqlRow[]) {
  const newest = new Map<string, SqlRow>();
  for (const draft of drafts) {
    const key = `${String(draft.account_id)}\u0000${String(draft.draft_id)}`;
    const current = newest.get(key);
    if (!current || Number(draft.revision) >= Number(current.revision)) {
      newest.set(key, draft);
    }
  }
  return [...newest.values()];
}

function ownedWork(
  work: PendingMailWork,
  ownedAccountIds: readonly string[],
  drops: DropCounter,
): PendingMailWork {
  const owned = new Set(ownedAccountIds);
  function keep<T>(table: string, rows: T[], accountOf: (row: T) => string) {
    const kept = rows.filter((row) => owned.has(accountOf(row)));
    drops.add(table, "not_owned", rows.length - kept.length);
    return kept;
  }
  const rowAccount = (row: SqlRow) => String(row.account_id);
  return {
    accounts: keep("accounts", work.accounts, (account) => account.accountId),
    drafts: keep("drafts", work.drafts, rowAccount),
    operations: keep("operations", work.operations, rowAccount),
    operationTargets: keep(
      "operation_targets",
      work.operationTargets,
      rowAccount,
    ),
    operationConversations: keep(
      "operation_conversations",
      work.operationConversations,
      rowAccount,
    ),
  };
}

type DropCounter = ReturnType<typeof createDropCounter>;

function createDropCounter() {
  const counts = new Map<string, DroppedMailWork>();
  return {
    add(table: string, reason: DroppedMailWork["reason"], count = 1) {
      if (count <= 0) return;
      const key = `${table}:${reason}`;
      const current = counts.get(key);
      counts.set(key, { table, reason, count: (current?.count ?? 0) + count });
    },
    list: () => [...counts.values()],
  };
}

function pick(row: SqlRow, columns: string[]): SqlRow {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}
