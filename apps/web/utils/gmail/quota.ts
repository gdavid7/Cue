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
// Refreshed by every page of a primary scan, so a scan that stops clears it.
const INITIAL_SYNC_TTL_MS = 90_000;
const BACKGROUND_PAUSE_MIN_MS = 30_000;

export type GmailQuotaPriority = "interactive" | "sync" | "background";

type GmailQuotaContext = { caller: string; priority: GmailQuotaPriority };

// Routes and actions whose Gmail reads only enrich or analyze mail the user
// already has, so they wait for capacity nobody else needs.
const BACKGROUND_CALLERS = [
  "user/inbox-insights",
  "user/thread-context",
  "user/suggested-reply",
  "user/thread-brief",
  "user/thread-plans",
  "user/meeting-briefs",
  "user/meeting-news",
  "user/stats",
  "user/senders",
  "user/trial-preview",
  "user/search-answer",
  "loadEmailStats",
  "response-time-stats",
  "clean/",
  "cron/",
  "resend/",
  "follow-up-reminders",
  "meeting-briefs",
  "mail/v1/assistant-state",
];
// Someone is waiting on these: a thread they opened, a message they send,
// a search they typed, a question they asked the assistant.
const INTERACTIVE_CALLERS = [
  "mail/v1/conversation-membership",
  "mail/v1/search",
  "mail/v1/attachment-content",
  "mail/v1/operations",
  "messages/",
  "threads/",
  "chat",
  "mobile/",
];

const quotaContext = new AsyncLocalStorage<GmailQuotaContext>();
const logger = createScopedLogger("gmail-quota");
const accountsByToken = new Map<string, string>();
const summarizedMinute = new Map<string, number>();

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

/** Runs `operation` with its Gmail calls charged to `caller` at `priority`. */
export function runWithGmailQuota<T>(
  context: { caller?: string; priority: GmailQuotaPriority },
  operation: () => T,
): T {
  return quotaContext.run(
    {
      caller: context.caller ?? currentGmailQuotaContext().caller,
      priority: context.priority,
    },
    operation,
  );
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
  const deadline = Date.now() + MAX_WAIT_MS[priority];
  for (;;) {
    let wait: number;
    try {
      wait = await gmailQuotaStore.take({
        bucketKey: keys.bucket,
        usageKey: keys.usage(minuteOf(Date.now())),
        usageField: `${priority}:${context.caller}`,
        blockers,
        cost,
        capacity: BUCKET.capacity,
        perMinute: BUCKET.perMinute,
        floor: FLOOR[priority],
      });
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
      gmailQuotaStore
        .note({
          usageKey: keys.usage(minuteOf(Date.now())),
          field: `deferred:${context.caller}`,
          amount: 1,
        })
        .catch(() => undefined);
      throw new GmailCallDeferredError(wait, priority);
    }
    await sleep(Math.min(wait, deadline - Date.now()));
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
  if (!ticket.emailAccountId || !isEmailProviderRateLimitRedisConfigured())
    return;
  const keys = accountKeys(ticket.emailAccountId);
  const retryAfterMs = Math.max(
    BACKGROUND_PAUSE_MIN_MS,
    retryAfterFromMessage(error) ?? 0,
  );
  try {
    await gmailQuotaStore.block({
      key: keys.backgroundPause,
      ms: retryAfterMs,
      drainBucketKey:
        ticket.priority === "background" ? undefined : keys.bucket,
    });
    await gmailQuotaStore.note({
      usageKey: keys.usage(minuteOf(Date.now())),
      field: `refused:${ticket.caller}`,
      amount: 1,
    });
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
 * the inbox fills before anything spends quota on analysis.
 */
export async function setGmailInitialSync(
  emailAccountId: string,
  active: boolean,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;
  const { initialSync } = accountKeys(emailAccountId);
  try {
    if (active)
      await gmailQuotaStore.block({
        key: initialSync,
        ms: INITIAL_SYNC_TTL_MS,
      });
    else await gmailQuotaStore.clear(initialSync);
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
  if (BACKGROUND_CALLERS.some((prefix) => caller.startsWith(prefix)))
    return "background";
  if (INTERACTIVE_CALLERS.some((prefix) => caller.startsWith(prefix)))
    return "interactive";
  return "sync";
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
  const usage = await gmailQuotaStore.claimUsage({
    usageKey: keys.usage(minute - 1),
    claimKey: `${keys.usage(minute - 1)}:logged`,
  });
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
