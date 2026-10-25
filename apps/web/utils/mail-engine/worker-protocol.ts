import type { MailEngineCapabilities } from "@inboxzero/mail-core/capabilities";
import type { MailClient, WorkAdmission } from "@inboxzero/mail-core/engine";
import type { QuerySnapshot } from "@inboxzero/mail-core/queries";
import type { DroppedMailWork } from "@inboxzero/mail-sqlite/recovery";

export type BrowserEngineStart = {
  accountId: string;
  provider: "google" | "microsoft";
  /** The signed-in user's accounts, whose carried-over work a rebuild may restore. */
  ownedAccountIds: string[];
  generation?: string;
  persist?: boolean;
  maxPendingOperations?: number;
  online?: boolean;
  /**
   * How long the semantic index waits after start, and between passes for
   * new mail; tests shorten it.
   */
  semanticIndexIntervalMs?: number;
  /**
   * The page has touch and no fine pointer: a phone or tablet, including an
   * iPad, whose user agent reads as a desktop's.
   */
  touchOnly?: boolean;
};

export function shouldReleaseDeferredOnStart(online?: boolean) {
  return online !== false;
}

export async function requestSyncUnlessOffline(
  online: boolean | undefined,
  sync: () => Promise<WorkAdmission>,
): Promise<WorkAdmission> {
  if (!shouldReleaseDeferredOnStart(online)) {
    return { status: "scheduled" };
  }
  return sync();
}

export function pageConnectivityOnline(): boolean | undefined {
  if (typeof navigator === "undefined") return;
  return navigator.onLine;
}

export type WorkerObserveKind =
  | "mailbox"
  | "mailboxCounts"
  | "mailboxWindow"
  | "conversation"
  | "operation";

export function observeByKind(
  client: MailClient,
  kind: WorkerObserveKind,
  args: unknown[],
) {
  switch (kind) {
    case "mailbox":
      return client.observeMailbox(args[0] as never);
    case "mailboxCounts":
      return client.observeMailboxCounts(args[0] as never);
    case "mailboxWindow":
      return (
        client.observeMailboxWindow?.(args[0] as never) ??
        client.observeMailbox(args[0] as never)
      );
    case "conversation":
      return client.observeConversation(args[0] as never, args[1] as never);
    case "operation":
      return client.observeOperation(args[0] as never);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unsupported observe kind ${exhaustive}`);
    }
  }
}

/**
 * Opens the mailbox before the engine starts, while the page still hydrates.
 * Only sent while the page holds the engine's owner lock, so no other tab
 * can need the files.
 */
export type WorkerPreopenRequest = {
  type: "preopen";
  maxPendingOperations?: number;
};

/** The page found the app session back; the worker's requests may go out again. */
export type WorkerSessionResetRequest = { type: "session_reset" };

/**
 * The worker's answer to `start`. Its engine reports its capabilities here so
 * the page knows them before the first query.
 */
export type WorkerStarted = { capabilities: MailEngineCapabilities };

export type WorkerRequest =
  | { id: string; type: "start"; input: BrowserEngineStart }
  | { id: string; type: "call"; method: string; args: unknown[] }
  | {
      id: string;
      type: "observe";
      kind: WorkerObserveKind;
      handleId: string;
      args: unknown[];
    }
  | { id: string; type: "loadMore"; handleId: string }
  | { id: string; type: "unobserve"; handleId: string }
  | { id: string; type: "close" };

export type WorkerResponse =
  | { id: string; type: "ok"; value?: unknown }
  | { id: string; type: "error"; message: string }
  | {
      type: "snapshots";
      snapshots: { handleId: string; snapshot: QuerySnapshot<unknown> }[];
    }
  /** The mailbox was corrupt and is being rebuilt while the engine starts. */
  | { type: "rebuilding" }
  /** Carried work a rebuild could not restore; counts only, no content. */
  | { type: "dropped"; drop: DroppedMailWork }
  /**
   * The worker stopped sending: no session ("signed-out"), or the gate
   * refused even a refreshed one ("rejected"). Only the page can act.
   */
  | { type: "session_expired"; reason: "signed-out" | "rejected" }
  /** A deployment other than the last one named answered a request. */
  | { type: "server_build"; buildId: string };

export function browserMailEngineCapabilities() {
  return {
    worker: typeof Worker !== "undefined",
    locks:
      typeof navigator !== "undefined" &&
      Boolean((navigator as Navigator & { locks?: unknown }).locks),
    opfs:
      typeof navigator !== "undefined" &&
      "storage" in navigator &&
      "getDirectory" in navigator.storage,
  };
}

export function workerStartFence(
  startedAccount: string | undefined,
  nextAccountId: string,
) {
  if (startedAccount !== undefined && startedAccount !== nextAccountId) {
    return "account_mismatch";
  }
  return null;
}

export function readPageMaxPendingOperations(): number | undefined {
  if (typeof window === "undefined") return;
  const value = window.__inboxZeroMailMaxPendingOperations;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return;
  }
  return Math.floor(value);
}

export function readPageTouchOnly(): boolean | undefined {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  return (
    navigator.maxTouchPoints > 0 &&
    !window.matchMedia?.("(pointer: fine)").matches
  );
}

/** Set by browser tests that need the semantic index without its delays. */
export function readPageSemanticIndexIntervalMs(): number | undefined {
  if (typeof window === "undefined") return;
  const value = window.__inboxZeroMailSemanticIndexIntervalMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return;
  }
  return value;
}

declare global {
  interface Window {
    __inboxZeroMailMaxPendingOperations?: number;
    __inboxZeroMailSemanticIndexIntervalMs?: number;
  }
}

const UNSUPPORTED_METHOD = "unsupported method";

/** What an engine answers when asked for a method it doesn't have. */
export function unsupportedMethodMessage(method: string) {
  return `${UNSUPPORTED_METHOD} ${method}`;
}

// A tab that relays to another tab's engine can reach one too old to answer.
export function isUnsupportedMethodError(error: unknown) {
  return (
    error instanceof Error && error.message.startsWith(`${UNSUPPORTED_METHOD} `)
  );
}
