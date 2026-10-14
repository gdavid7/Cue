import { AsyncLocalStorage } from "node:async_hooks";
import { getAuditContext } from "@/utils/audit/context";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { extractErrorInfo, isRetryableError } from "@/utils/gmail/retry";
import { createScopedLogger } from "@/utils/logger";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";
import { sleep } from "@/utils/sleep";

// Gmail allows 6,000 units per user per minute for each Google Cloud project,
// so every route, tab, device and job of one account shares that minute.
// https://developers.google.com/workspace/gmail/api/reference/quota
export const GMAIL_USER_UNITS_PER_MINUTE = 6000;

// Any 60 seconds can spend at most the full bucket, the interactive overdraft
// and one minute of refill: 1,000 + 200 + 3,600 = 4,800, 80% of Gmail's limit.
const BUCKET = { capacity: 1000, perMinute: 3600 };
// What each priority must leave in the bucket after its debit. Sync leaves a
// slice that only interactive calls may spend; background leaves more, so it
// only runs on capacity nobody in front of the mailbox is using.
const FLOOR: Record<GmailQuotaPriority, number> = {
  interactive: -200,
  sync: 200,
  background: 500,
};
const MAX_WAIT_MS: Record<GmailQuotaPriority, number> = {
  interactive: 10_000,
  sync: 15_000,
  background: 15_000,
};
// Refreshed while a primary scan pages through, so a scan that stops clears it.
const INITIAL_SYNC_TTL_MS = 90_000;
const INITIAL_SYNC_REFRESH_MS = 30_000;
// The REST client retries for seconds; a gate that cannot coordinate within
// this long lets the call through rather than stall every Gmail call.
const STORE_TIMEOUT_MS = 300;
const BACKGROUND_PAUSE_MIN_MS = 30_000;

export type GmailQuotaPriority = "interactive" | "sync" | "background";

/** What one unit of work (such as an assistant tool call) met at the gate. */
export type GmailQuotaStats = {
  waitMs: number;
  deferred: number;
  refused: number;
  rateLimitMode: number;
};

type GmailQuotaContext = {
  caller: string;
  priority: GmailQuotaPriority;
  stats?: GmailQuotaStats;
  /** Caps the gate waits of every call in this context together. */
  maxTotalWaitMs?: number;
};

// Route scopes, matched exactly so a route added under a background path is
// never held back by accident. Interactive: someone is waiting on it, for a
// thread they opened, a message they send, a search they typed, a bulk action
// they clicked or a question they asked the assistant. Background: it only
// enriches or analyzes mail the user already has. Any other route, the sync
// engine's scans, Today and webhooks among them, is sync.
const ROUTE_PRIORITY = new Map<string, GmailQuotaPriority>([
  ...withPriority("interactive", [
    "mail/v1/conversation-membership",
    "mail/v1/search",
    "mail/v1/attachment-content",
    "mail/v1/operations",
    "mail/v1/operations/cancel",
    "mail/v1/operations/inspect",
    "messages",
    "messages/attachment",
    "messages/batch",
    "messages/calendar-invitation",
    "messages/forward",
    "messages/raw",
    "messages/send",
    "threads",
    "threads/all",
    "threads/archive",
    "threads/basic",
    "threads/batch",
    "threads/detail",
    "threads/trash",
    "threads/unarchive",
    "threads/untrash",
    "chat",
    "chat/confirm-email-action",
    "chat/stream",
    "slack/commands",
    "slack/events",
    "teams/events",
    "telegram/events",
    "voice/live/session",
    "mobile/all-inboxes",
    "mobile/all-inboxes/archive",
    "mobile/otps",
    "mobile/threads/batch",
    "user/senders/bulk",
    "user/senders/status",
    "user/senders/unsubscribe",
    "v1/senders/unsubscribe",
    "user/search-answer",
    "user/drafts",
    "user/drafts/attachments/add",
    "user/drafts/attachments/list",
    "user/drafts/attachments/remove",
    "user/drafts/attachments/upload-chunk",
    "user/drafts/attachments/upload-start",
    "user/drafts/discard",
    "user/drafts/read",
    "user/drafts/read-for-message",
    "user/drafts/update",
    "user/scheduled-emails/cancel",
    "user/scheduled-emails/reminder",
    "user/scheduled-emails/retry",
    "user/snoozed-threads/create",
    "user/snoozed-threads/delete",
  ]),
  ...withPriority("background", [
    "user/inbox-insights",
    "user/thread-context",
    "user/suggested-reply",
    "user/thread-brief",
    "user/thread-plans",
    "user/meeting-briefs",
    "user/meeting-briefs/history",
    "user/meeting-news",
    "user/stats/load",
    "user/stats/newsletters",
    "user/stats/recipients",
    "user/stats/sender-emails",
    "user/stats/senders",
    "user/trial-preview",
    "user/categorize/senders/batch",
    "user/categorize/senders/batch/simple",
    "response-time-stats",
    "v1/stats/by-period",
    "v1/stats/response-time",
    "clean/gmail",
    "clean/history",
    "follow-up-reminders",
    "follow-up-reminders/account",
    "meeting-briefs",
    "automation-jobs/execute",
    "mail/v1/assistant-state",
  ]),
]);
// Jobs nobody waits on; a durable send one delivers raises itself to
// interactive.
const BACKGROUND_NAMESPACES = ["cron/", "resend/"];
// Server actions are a person's clicks, except these the app fires by itself
// when a page loads.
const BACKGROUND_ACTIONS = new Set([
  "loadEmailStats",
  "assessUser",
  "analyzeWritingStyle",
  "whitelistInboxZero",
]);

const quotaContext = new AsyncLocalStorage<GmailQuotaContext>();
const logger = createScopedLogger("gmail-quota");
const accountsByToken = new Map<string, string>();
const summarizedMinute = new Map<string, number>();
const initialSyncMarkedAt = new Map<string, number>();

export class GmailCallDeferredError extends Error {
  readonly code = "GMAIL_CALL_DEFERRED";
  readonly retryAfterMs: number;
  readonly priority: GmailQuotaPriority;
  constructor(retryAfterMs: number, priority: GmailQuotaPriority) {
    super(
      `Gmail call deferred for ${Math.ceil(retryAfterMs / 1000)}s to keep the account within its per-minute Gmail budget`,
    );
    this.name = "GmailCallDeferredError";
    this.retryAfterMs = Math.max(1000, Math.ceil(retryAfterMs));
    this.priority = priority;
  }
}

export function isGmailCallDeferredError(
  error: unknown,
): error is GmailCallDeferredError {
  if (error instanceof GmailCallDeferredError) return true;
  // Gaxios wraps errors thrown below it.
  return (
    !!error &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause instanceof GmailCallDeferredError
  );
}

export function getGmailCallDeferredError(error: unknown) {
  if (error instanceof GmailCallDeferredError) return error;
  if (isGmailCallDeferredError(error))
    return (error as { cause: GmailCallDeferredError }).cause;
  return null;
}

/**
 * Runs `operation` with its Gmail calls charged to `caller` at `priority`.
 * With `stats`, what the calls met at the gate is added to it; with
 * `maxTotalWaitMs`, the calls share that much waiting before they defer.
 */
export function runWithGmailQuota<T>(
  context: {
    caller?: string;
    priority: GmailQuotaPriority;
    stats?: GmailQuotaStats;
    maxTotalWaitMs?: number;
  },
  operation: () => T,
): T {
  const current = currentGmailQuotaContext();
  return quotaContext.run(
    {
      caller: context.caller ?? current.caller,
      priority: context.priority,
      stats: context.stats ?? current.stats,
      maxTotalWaitMs: context.maxTotalWaitMs ?? current.maxTotalWaitMs,
    },
    operation,
  );
}

export function createGmailQuotaStats(): GmailQuotaStats {
  return { waitMs: 0, deferred: 0, refused: 0, rateLimitMode: 0 };
}

/** Counts a call skipped because the account is in provider rate-limit mode. */
export function noteRateLimitModeSkip() {
  const stats = quotaContext.getStore()?.stats;
  if (stats) stats.rateLimitMode += 1;
}

/** The priority of a server action's Gmail calls: a click, unless the app fires it. */
export function gmailQuotaPriorityForAction(name: string): GmailQuotaPriority {
  return BACKGROUND_ACTIONS.has(name) ? "background" : "interactive";
}

export function currentGmailQuotaContext(): GmailQuotaContext {
  const explicit = quotaContext.getStore();
  if (explicit) return explicit;
  const caller = normalizeCaller(getAuditContext().source);
  return { caller, priority: priorityForCaller(caller) };
}

/**
 * Batch requests only carry an access token, so the client that issued the
 * token records which account it belongs to.
 */
export function rememberGmailAccessToken(
  token: string,
  emailAccountId: string,
) {
  if (accountsByToken.get(token) === emailAccountId) return;
  accountsByToken.set(token, emailAccountId);
  if (accountsByToken.size > 1000) {
    const oldest = accountsByToken.keys().next().value;
    if (oldest) accountsByToken.delete(oldest);
  }
}

export function gmailAccountForAccessToken(token: string) {
  return accountsByToken.get(token) ?? getAuditContext().emailAccountId;
}

/**
 * The single admission point for Gmail traffic: waits until the account's
 * shared budget can pay `cost`, runs `operation`, and turns a Gmail quota
 * refusal into a pause for the callers that should yield.
 */
export async function meterGmailCall<T>(
  {
    emailAccountId,
    cost,
    priority: priorityOverride,
  }: {
    emailAccountId: string | undefined;
    cost: number;
    priority?: GmailQuotaPriority;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const ticket = await admitGmailCall({
    emailAccountId,
    cost,
    priority: priorityOverride,
  });
  try {
    return await operation();
  } catch (error) {
    if (isGmailQuotaRefusal(error)) await noteGmailQuotaRefusal(ticket, error);
    throw error;
  }
}

export type GmailQuotaTicket = {
  emailAccountId: string | undefined;
  caller: string;
  priority: GmailQuotaPriority;
};

export async function admitGmailCall({
  emailAccountId,
  cost,
  priority: priorityOverride,
}: {
  emailAccountId: string | undefined;
  cost: number;
  priority?: GmailQuotaPriority;
}): Promise<GmailQuotaTicket> {
  const context = currentGmailQuotaContext();
  const priority = priorityOverride ?? context.priority;
  const ticket = { emailAccountId, caller: context.caller, priority };
  if (!emailAccountId || !isEmailProviderRateLimitRedisConfigured())
    return ticket;

  const keys = accountKeys(emailAccountId);
  const blockers =
    priority === "background" ? [keys.initialSync, keys.backgroundPause] : [];
  const { stats, maxTotalWaitMs } = context;
  const deadline =
    Date.now() +
    Math.min(
      MAX_WAIT_MS[priority],
      maxTotalWaitMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, maxTotalWaitMs - (stats?.waitMs ?? 0)),
    );
  for (;;) {
    let wait: number;
    try {
      wait = await withinStoreTimeout(
        gmailQuotaStore.take({
          bucketKey: keys.bucket,
          usageKey: keys.usage(minuteOf(Date.now())),
          usageField: `${priority}:${context.caller}`,
          blockers,
          cost,
          capacity: BUCKET.capacity,
          perMinute: BUCKET.perMinute,
          floor: FLOOR[priority],
        }),
      );
    } catch (error) {
      // Without the shared store nothing can be coordinated; Gmail's own
      // limit still protects the account, so the call goes ahead.
      logger.warn("Gmail quota store unavailable", { error });
      return ticket;
    }
    if (wait === 0) {
      summarizeLastMinute(emailAccountId).catch(() => undefined);
      return ticket;
    }
    if (Date.now() + wait > deadline) {
      withinStoreTimeout(
        gmailQuotaStore.note({
          usageKey: keys.usage(minuteOf(Date.now())),
          field: `deferred:${context.caller}`,
          amount: 1,
        }),
      ).catch(() => undefined);
      if (stats) stats.deferred += 1;
      throw new GmailCallDeferredError(wait, priority);
    }
    const sleepMs = Math.min(wait, deadline - Date.now());
    await sleep(sleepMs);
    if (stats) stats.waitMs += sleepMs;
  }
}

/**
 * Gmail refused a call for quota. A background caller only pauses background
 * work; anyone else also empties the shared bucket so every caller backs off
 * until Gmail's minute has refilled.
 */
export async function noteGmailQuotaRefusal(
  ticket: GmailQuotaTicket,
  error?: unknown,
) {
  const stats = quotaContext.getStore()?.stats;
  if (stats) stats.refused += 1;
  if (!ticket.emailAccountId || !isEmailProviderRateLimitRedisConfigured())
    return;
  const keys = accountKeys(ticket.emailAccountId);
  const retryAfterMs = Math.max(
    BACKGROUND_PAUSE_MIN_MS,
    retryAfterFromMessage(error) ?? 0,
  );
  try {
    await withinStoreTimeout(
      gmailQuotaStore.block({
        key: keys.backgroundPause,
        ms: retryAfterMs,
        drainBucketKey:
          ticket.priority === "background" ? undefined : keys.bucket,
      }),
    );
    await withinStoreTimeout(
      gmailQuotaStore.note({
        usageKey: keys.usage(minuteOf(Date.now())),
        field: `refused:${ticket.caller}`,
        amount: 1,
      }),
    );
  } catch (storeError) {
    logger.warn("Failed to record Gmail quota refusal", { error: storeError });
  }
}

export function isGmailQuotaRefusal(error: unknown) {
  if (isGmailCallDeferredError(error)) return false;
  const info = extractErrorInfo(error);
  return (
    (info.status === 403 || info.status === 429) &&
    isRetryableError(info).isRateLimit
  );
}

/**
 * Marks a primary scan in progress. Background callers wait until it ends so
 * the inbox fills before anything spends quota on analysis. Every page of a
 * scan calls this; the marker is only written when it is due for a refresh.
 */
export async function setGmailInitialSync(
  emailAccountId: string,
  active: boolean,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;
  const { initialSync } = accountKeys(emailAccountId);
  const markedAt = initialSyncMarkedAt.get(emailAccountId);
  if (
    active &&
    markedAt !== undefined &&
    Date.now() - markedAt < INITIAL_SYNC_REFRESH_MS
  )
    return;
  try {
    if (active) {
      await withinStoreTimeout(
        gmailQuotaStore.block({ key: initialSync, ms: INITIAL_SYNC_TTL_MS }),
      );
      rememberInitialSyncMark(emailAccountId);
    } else {
      initialSyncMarkedAt.delete(emailAccountId);
      await withinStoreTimeout(gmailQuotaStore.clear(initialSync));
    }
  } catch (error) {
    logger.warn("Failed to update Gmail initial sync state", { error });
  }
}

/**
 * The documented quota cost of one Gmail REST call, from its HTTP method and
 * URL. Unknown calls are charged like a write so they are never undercounted.
 */
export function gmailRequestCost(method: string, url: string | URL): number {
  const pathname =
    typeof url === "string" ? new URL(url, "https://x").pathname : url.pathname;
  const match = pathname.match(/\/gmail\/v1\/users\/[^/]+(\/.*)?$/);
  const parts = (match?.[1] ?? "").split("/").filter(Boolean);
  const verb = method.toUpperCase();
  const [resource, id, action] = parts;
  if (!resource || resource === "profile") return 1;
  if (resource === "watch") return 100;
  if (resource === "stop") return 50;
  if (resource === "history") return 2;
  if (resource === "labels") return verb === "GET" ? 1 : 5;
  if (resource === "settings") {
    if (verb === "GET") return 1;
    if (verb === "DELETE") return 5;
    const kind = parts[1];
    return kind === "sendAs" ||
      kind === "forwardingAddresses" ||
      kind === "delegates" ||
      kind === "pop"
      ? 100
      : 5;
  }
  if (resource === "messages") {
    if (!id) return verb === "GET" ? 5 : 25;
    if (id === "send") return 100;
    if (id === "batchModify" || id === "batchDelete") return 50;
    if (id === "import") return 25;
    if (action === "attachments") return 20;
    if (action === "modify" || action === "untrash") return 5;
    if (action === "trash") return 20;
    return verb === "DELETE" ? 10 : 20;
  }
  if (resource === "threads") {
    if (!id) return 10;
    if (action === "modify" || action === "untrash") return 10;
    if (action === "trash") return 20;
    return verb === "DELETE" ? 20 : 40;
  }
  if (resource === "drafts") {
    if (!id) return verb === "GET" ? 5 : 10;
    if (id === "send") return 100;
    if (verb === "GET") return 20;
    if (verb === "DELETE") return 10;
    return 15;
  }
  return 20;
}

function priorityForCaller(caller: string): GmailQuotaPriority {
  const routePriority = ROUTE_PRIORITY.get(caller);
  if (routePriority) return routePriority;
  if (
    BACKGROUND_ACTIONS.has(caller) ||
    BACKGROUND_NAMESPACES.some((prefix) => caller.startsWith(prefix))
  )
    return "background";
  return "sync";
}

function withPriority(priority: GmailQuotaPriority, callers: string[]) {
  return callers.map((caller) => [caller, priority] as const);
}

// Route scopes and action names are fixed strings; a bare path can carry ids.
function normalizeCaller(source: string | undefined) {
  if (!source) return "unattributed";
  const caller = source.startsWith("/")
    ? source
        .split("/")
        .map((segment) =>
          /\d/.test(segment) && segment.length >= 8 ? ":id" : segment,
        )
        .join("/")
    : source;
  return caller.slice(0, 80);
}

async function summarizeLastMinute(emailAccountId: string) {
  const minute = minuteOf(Date.now());
  if (summarizedMinute.get(emailAccountId) === minute) return;
  summarizedMinute.set(emailAccountId, minute);
  if (summarizedMinute.size > 1000) {
    const oldest = summarizedMinute.keys().next().value;
    if (oldest) summarizedMinute.delete(oldest);
  }
  const keys = accountKeys(emailAccountId);
  const usage = await withinStoreTimeout(
    gmailQuotaStore.claimUsage({
      usageKey: keys.usage(minute - 1),
      claimKey: `${keys.usage(minute - 1)}:logged`,
    }),
  );
  if (!usage || Object.keys(usage).length === 0) return;
  const units: Record<string, number> = {};
  const deferred: Record<string, number> = {};
  const refused: Record<string, number> = {};
  let totalUnits = 0;
  for (const [field, value] of Object.entries(usage)) {
    if (field.startsWith("deferred:")) deferred[field.slice(9)] = value;
    else if (field.startsWith("refused:")) refused[field.slice(8)] = value;
    else {
      units[field] = value;
      totalUnits += value;
    }
  }
  logger.info("Gmail quota usage", {
    emailAccountId,
    minute: new Date((minute - 1) * 60_000).toISOString(),
    totalUnits,
    limitUnits: GMAIL_USER_UNITS_PER_MINUTE,
    unitsByCaller: units,
    deferredByCaller: deferred,
    refusedByCaller: refused,
  });
}

function rememberInitialSyncMark(emailAccountId: string) {
  initialSyncMarkedAt.delete(emailAccountId);
  initialSyncMarkedAt.set(emailAccountId, Date.now());
  if (initialSyncMarkedAt.size > 1000) {
    const oldest = initialSyncMarkedAt.keys().next().value;
    if (oldest) initialSyncMarkedAt.delete(oldest);
  }
}

async function withinStoreTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Gmail quota store timed out")),
          STORE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterFromMessage(error: unknown) {
  const message = extractErrorInfo(error).errorMessage;
  const match = message.match(/Retry after (\S+)/i);
  if (!match?.[1]) return null;
  const at = Date.parse(match[1]);
  return Number.isNaN(at) ? null : at - Date.now();
}

function minuteOf(ms: number) {
  return Math.floor(ms / 60_000);
}

function accountKeys(emailAccountId: string) {
  const prefix = `gmail-quota:${emailAccountId}`;
  return {
    bucket: `${prefix}:bucket`,
    initialSync: `${prefix}:initial-sync`,
    backgroundPause: `${prefix}:background-pause`,
    usage: (minute: number) => `${prefix}:usage:${minute}`,
  };
}
