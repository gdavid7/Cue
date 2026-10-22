import type { MailClient } from "@inboxzero/mail-core/engine";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import {
  type MailMark,
  recordMailMark,
} from "@/utils/analytics/mail-performance";
import { createClientLogger } from "@/utils/logger-client";

/**
 * Real-user timing of the interactions the product promises are instant, each
 * measured from the user's input to what they see. One event per measurement
 * goes to Axiom through the client logger. Events carry enums and numbers
 * only, and `buildRumEvent` copies a fixed set of fields, so nothing typed or
 * read by the user (addresses, subjects, snippets, search text) can ride along.
 */

/** Share of measurements sent, except those in RUM_ALWAYS_SENT. */
export const RUM_SAMPLE_RATE = 0.1;

const RUM_ACTIONS = [
  "app_open_cold",
  "app_open_returning",
  "app_open_fresh_sign_in",
  "account_switch_first_row",
  "thread_open",
  "archive_optimistic",
  "archive_confirmed",
  "star_optimistic",
  "star_confirmed",
  "mark_read_optimistic",
  "mark_read_confirmed",
  "compose_open",
  "search_plain",
  "search_cue_found",
  "reply_suggestion",
] as const;

export type RumActionName = (typeof RUM_ACTIONS)[number];
export type RumOutcome = "ok" | "empty" | "error" | "timeout";

/** Always sent, at 100%. Errors and timeouts are too, for every action. */
export const RUM_ALWAYS_SENT: ReadonlySet<RumActionName> = new Set([
  "app_open_cold",
  "app_open_returning",
  "app_open_fresh_sign_in",
]);

const FIRST_ROW_ACTIONS: readonly RumActionName[] = [
  "app_open_cold",
  "app_open_returning",
  "app_open_fresh_sign_in",
  "account_switch_first_row",
];

const MAIL_MARK_BY_ACTION: Partial<Record<RumActionName, MailMark>> = {
  app_open_returning: "first_row_cached",
  app_open_cold: "first_row_fresh",
  app_open_fresh_sign_in: "first_row_fresh",
  compose_open: "compose_ready",
};

const SLOW_START_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const TIMEOUT_MS: Partial<Record<RumActionName, number>> = {
  app_open_cold: SLOW_START_TIMEOUT_MS,
  app_open_returning: SLOW_START_TIMEOUT_MS,
  app_open_fresh_sign_in: SLOW_START_TIMEOUT_MS,
  account_switch_first_row: SLOW_START_TIMEOUT_MS,
};
// A tab that sat in the background measures its wait, not the app.
const MAX_REPORTED_MS = 10 * 60 * 1000;
const MOBILE_BREAKPOINT_PX = 768;
const LAST_SYNC_KEY_PREFIX = "cue-rum-last-sync:";
const RUM_EVENT_MESSAGE = "rum.action";

const HOUR_MS = 60 * 60 * 1000;
const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "needs_attention",
  "cancelled",
  "superseded",
]);

type HoursSinceLastSync = "unknown" | "lt1h" | "1to6h" | "6to24h" | "gt24h";
type RumProvider = "google" | "microsoft" | "unknown";

type RumContext = {
  accountId: string | null;
  provider: RumProvider;
  accountCount: number;
  hoursSinceLastSync: HoursSinceLastSync;
};

type PendingAction = {
  startedAt: number;
  key?: string;
  timer: ReturnType<typeof setTimeout>;
};

let context: RumContext = {
  accountId: null,
  provider: "unknown",
  accountCount: 0,
  hoursSinceLastSync: "unknown",
};
let lifecycleListenersAdded = false;
let logger: ReturnType<typeof createClientLogger> | undefined;
const pending = new Map<RumActionName, PendingAction>();

/**
 * What every event says about the browser and account. The last sync is read
 * once, before this page stamps its own, so it tells how stale the local store
 * was when the session began.
 */
export function setRumContext(input: {
  accountId: string;
  provider: string | null | undefined;
  accountCount: number;
}) {
  const accountChanged = context.accountId !== input.accountId;
  context = {
    accountId: input.accountId,
    provider: toRumProvider(input.provider),
    accountCount: input.accountCount,
    hoursSinceLastSync: accountChanged
      ? bucketHoursSinceLastSync(readLastSync(input.accountId), Date.now())
      : context.hoursSinceLastSync,
  };
  if (!lifecycleListenersAdded && typeof window !== "undefined") {
    lifecycleListenersAdded = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stampLastSync();
    });
    window.addEventListener("pagehide", stampLastSync);
  }
}

/** Starts timing; `startedAt` defaults to now, in performance.now() terms. */
export function beginRumAction(
  name: RumActionName,
  options: { key?: string; startedAt?: number } = {},
) {
  safely(() => {
    clearPending(name);
    const startedAt = options.startedAt ?? performance.now();
    const timeoutMs = TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () => {
        pending.delete(name);
        emit(name, performance.now() - startedAt, "timeout");
      },
      Math.max(0, timeoutMs - (performance.now() - startedAt)),
    );
    pending.set(name, { startedAt, key: options.key, timer });
  }, undefined);
}

/**
 * Ends a timing begun with `beginRumAction`. A success is measured after the
 * next paint, since the change is only visible then. Nothing happens when no
 * timing is pending, or when it belongs to another key.
 */
export function completeRumAction(
  name: RumActionName,
  options: { key?: string; outcome?: RumOutcome } = {},
) {
  return safely(() => {
    const action = pending.get(name);
    if (!action) return false;
    if (options.key !== undefined && action.key !== options.key) return false;
    clearPending(name);
    const outcome = options.outcome ?? "ok";
    if (outcome === "error" || outcome === "timeout") {
      emit(name, performance.now() - action.startedAt, outcome);
    } else {
      afterNextPaint(() =>
        emit(name, performance.now() - action.startedAt, outcome),
      );
    }
    return true;
  }, false);
}

export function cancelRumAction(name: RumActionName, key?: string) {
  safely(() => {
    const action = pending.get(name);
    if (!action || (key !== undefined && action.key !== key)) return;
    clearPending(name);
  }, undefined);
}

/** Times something that is not on screen, such as a refused command. */
export function recordRumAction(
  name: RumActionName,
  startedAt: number,
  outcome: RumOutcome = "ok",
) {
  safely(() => emit(name, performance.now() - startedAt, outcome), undefined);
}

/** Times something already on screen, such as an optimistic row change. */
export function recordRumAfterPaint(
  name: RumActionName,
  startedAt: number,
  outcome: RumOutcome = "ok",
) {
  safely(
    () =>
      afterNextPaint(() => emit(name, performance.now() - startedAt, outcome)),
    undefined,
  );
}

/**
 * The list has loaded, which ends an app open or account switch: "ok" once
 * the first rows are painted, "empty" for a mailbox with nothing in the view.
 */
export function markRumRowsShown(outcome: "ok" | "empty" = "ok") {
  safely(() => {
    let completed = false;
    for (const name of FIRST_ROW_ACTIONS) {
      completed = completeRumAction(name, { outcome }) || completed;
    }
    if (completed) stampLastSync();
  }, undefined);
}

export function failRumFirstRow() {
  for (const name of FIRST_ROW_ACTIONS) {
    completeRumAction(name, { outcome: "error" });
  }
}

/**
 * Times a queued change to the engine's word that the server has it. Only
 * ends in a measurement when the operation succeeds or fails; an undo, a newer
 * change replacing it, or an operation the engine no longer knows says nothing
 * about the server. Whatever goes wrong here is dropped: it must never reach
 * the change being timed.
 */
export function observeRumConfirmation(input: {
  client: MailClient;
  accountId: string;
  operationId: string;
  name: RumActionName;
  startedAt: number;
}) {
  const { client, name, startedAt } = input;
  let handle: ReturnType<MailClient["observeOperation"]> | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const release = () => {
    settled = true;
    safely(() => timer && clearTimeout(timer), undefined);
    safely(() => unsubscribe?.(), undefined);
    safely(() => handle?.close(), undefined);
  };
  const settle = (outcome: RumOutcome | null) => {
    if (settled) return;
    release();
    if (outcome) emit(name, performance.now() - startedAt, outcome);
  };
  const check = () => {
    if (settled) return;
    try {
      const operation = handle?.getSnapshot().data;
      const status = operation?.status;
      if (!status || !TERMINAL_OPERATION_STATUSES.has(status)) return;
      if (status === "succeeded") settle("ok");
      else if (status === "failed" && operation?.error?.code === "not_found")
        settle(null);
      else if (status === "failed" || status === "needs_attention")
        settle("error");
      else settle(null);
    } catch {
      release();
    }
  };
  try {
    handle = client.observeOperation({
      accountId: input.accountId,
      operationId: input.operationId,
    });
    unsubscribe = handle.subscribe(check);
    timer = setTimeout(
      () => settle("timeout"),
      Math.max(0, DEFAULT_TIMEOUT_MS - (performance.now() - startedAt)),
    );
    check();
  } catch {
    release();
  }
}

export function rumSampleRate(name: RumActionName, outcome: RumOutcome) {
  if (outcome === "error" || outcome === "timeout") return 1;
  return RUM_ALWAYS_SENT.has(name) ? 1 : RUM_SAMPLE_RATE;
}

export function buildRumEvent(input: {
  name: RumActionName;
  ms: number;
  outcome: RumOutcome;
  sampleRate: number;
  context: Omit<RumContext, "accountId">;
  viewportWidth: number;
}) {
  return {
    name: input.name,
    ms: Math.round(input.ms),
    outcome: input.outcome,
    provider: input.context.provider,
    accountCount: input.context.accountCount,
    hoursSinceLastSync: input.context.hoursSinceLastSync,
    device: input.viewportWidth < MOBILE_BREAKPOINT_PX ? "mobile" : "desktop",
    sampleRate: input.sampleRate,
  } as const;
}

export function bucketHoursSinceLastSync(
  lastSyncAt: number | null,
  now: number,
): HoursSinceLastSync {
  if (lastSyncAt === null || lastSyncAt > now) return "unknown";
  const hours = (now - lastSyncAt) / HOUR_MS;
  if (hours < 1) return "lt1h";
  if (hours < 6) return "1to6h";
  if (hours < 24) return "6to24h";
  return "gt24h";
}

export function resetRumActionsForTesting() {
  for (const name of [...pending.keys()]) clearPending(name);
  context = {
    accountId: null,
    provider: "unknown",
    accountCount: 0,
    hoursSinceLastSync: "unknown",
  };
  logger = undefined;
}

function emit(name: RumActionName, ms: number, outcome: RumOutcome) {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_REPORTED_MS) return;
  if (outcome === "ok") feedMailPerformance(name, ms);
  const sampleRate = rumSampleRate(name, outcome);
  if (Math.random() >= sampleRate) return;
  const event = buildRumEvent({
    name,
    ms,
    outcome,
    sampleRate,
    context,
    viewportWidth: window.innerWidth,
  });
  try {
    logger ??= createClientLogger("rum");
    logger.info(RUM_EVENT_MESSAGE, event);
    if (sampleRate === 1) logger.flush().catch(() => {});
  } catch {
    // A logging failure must not surface in the interaction it measured.
  }
}

// The sampled-session summary reuses these timings; "returning" is the
// app open that found the mailbox in the local store.
function feedMailPerformance(name: RumActionName, ms: number) {
  const mark = MAIL_MARK_BY_ACTION[name];
  if (mark) safely(() => recordMailMark(mark, ms), undefined);
}

function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    // Timing must never get in the way of the interaction it times.
    return fallback;
  }
}

function clearPending(name: RumActionName) {
  const action = pending.get(name);
  if (!action) return;
  clearTimeout(action.timer);
  pending.delete(name);
}

// A frame is painted once its callback has run and the next task starts.
function afterNextPaint(callback: () => void) {
  if (typeof requestAnimationFrame === "undefined") {
    callback();
    return;
  }
  requestAnimationFrame(() => setTimeout(callback, 0));
}

function toRumProvider(provider: string | null | undefined): RumProvider {
  if (isGoogleProvider(provider)) return "google";
  if (isMicrosoftProvider(provider)) return "microsoft";
  return "unknown";
}

function readLastSync(accountId: string): number | null {
  try {
    const value = Number(
      localStorage.getItem(`${LAST_SYNC_KEY_PREFIX}${accountId}`),
    );
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function stampLastSync() {
  if (!context.accountId) return;
  try {
    localStorage.setItem(
      `${LAST_SYNC_KEY_PREFIX}${context.accountId}`,
      String(Date.now()),
    );
  } catch {
    // Storage can be blocked; the next session then reports "unknown".
  }
}
