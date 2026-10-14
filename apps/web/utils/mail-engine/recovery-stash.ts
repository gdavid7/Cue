import type {
  PendingMailWork,
  PendingMailWorkStash,
} from "@inboxzero/mail-sqlite/recovery";

// Kept outside the mailbox's OPFS directory so wiping the mailbox for a
// rebuild leaves it in place.
const RECOVERY_DATABASE = "inbox-zero-mail-recovery";
const RECOVERY_STORE = "pending";
const RECOVERY_KEY = "work";
const RECOVERY_DELETE_BLOCKED_WAIT_MS = 5000;

/**
 * Holds drafts and unsent commands while a corrupt mailbox is rebuilt. Without
 * IndexedDB the work only lives as long as this page; a write or clear that
 * IndexedDB fails is reported, so the rebuild stops rather than lose work.
 */
export function createMailRecoveryStash(): PendingMailWorkStash {
  let fallback: PendingMailWork | null = null;
  return {
    async read() {
      if (typeof indexedDB === "undefined") return fallback;
      // A failed read is reported, not answered as empty: the rebuild would
      // otherwise write over whatever the stash still holds.
      return (
        (await withStore("readonly", (store) => store.get(RECOVERY_KEY))) ??
        fallback
      );
    },
    async write(work) {
      fallback = work;
      if (typeof indexedDB === "undefined") return;
      await withStore("readwrite", (store) => store.put(work, RECOVERY_KEY));
    },
    async clear() {
      fallback = null;
      if (typeof indexedDB === "undefined") return;
      await withStore("readwrite", (store) => store.delete(RECOVERY_KEY));
    },
  };
}

/**
 * Sign-out removes the carried work along with the mailbox it came from.
 * Resolves false while the stash is still there, so the wipe stays pending.
 */
export function deleteMailRecoveryStash(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return Promise.resolve(true);
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(RECOVERY_DATABASE);
    // A blocked delete still completes once the open connection closes; one
    // that never does is finished by the next engine start instead.
    const giveUp = setTimeout(
      () => resolve(false),
      RECOVERY_DELETE_BLOCKED_WAIT_MS,
    );
    const settle = (deleted: boolean) => {
      clearTimeout(giveUp);
      resolve(deleted);
    };
    request.onsuccess = () => settle(true);
    request.onerror = () => settle(false);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(RECOVERY_DATABASE, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(RECOVERY_STORE);
    };
    open.onerror = () =>
      reject(open.error ?? new Error("IndexedDB could not be opened"));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(RECOVERY_STORE, mode);
      const request = run(transaction.objectStore(RECOVERY_STORE));
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      };
    };
  });
}
