import type {
  PendingMailWork,
  PendingMailWorkStash,
} from "@inboxzero/mail-sqlite/recovery";

// Kept outside the mailbox's OPFS directory so wiping the mailbox for a
// rebuild leaves it in place.
const RECOVERY_DATABASE = "inbox-zero-mail-recovery";
const RECOVERY_STORE = "pending";
const RECOVERY_KEY = "work";

/**
 * Holds drafts and unsent commands while a corrupt mailbox is rebuilt. Without
 * IndexedDB the work only lives as long as this page.
 */
export function createMailRecoveryStash(): PendingMailWorkStash {
  let fallback: PendingMailWork | null = null;
  return {
    async read() {
      try {
        return (
          (await withStore("readonly", (store) => store.get(RECOVERY_KEY))) ??
          fallback
        );
      } catch {
        return fallback;
      }
    },
    async write(work) {
      fallback = work;
      await withStore("readwrite", (store) => store.put(work, RECOVERY_KEY));
    },
    async clear() {
      fallback = null;
      await withStore("readwrite", (store) => store.delete(RECOVERY_KEY));
    },
  };
}

/** Sign-out removes the carried work along with the mailbox it came from. */
export function deleteMailRecoveryStash(): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(RECOVERY_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
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
    open.onerror = () => reject(open.error);
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
        reject(transaction.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  });
}
