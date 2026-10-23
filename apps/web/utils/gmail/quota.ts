import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { env } from "@/env";
import { getAuditContext } from "@/utils/audit/context";
import {
  type GmailQuotaHold,
  type GmailQuotaNote,
  gmailQuotaStore,
} from "@/utils/gmail/quota-store";
import { takeGmailInflightStats } from "@/utils/gmail/inflight";
import { extractErrorInfo, isRetryableError } from "@/utils/gmail/retry";
import { createScopedLogger } from "@/utils/logger";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";
import { getRequestDeadline } from "@/utils/request-deadline-reader";
import {
  getFastRequestSampleRate,
  isFastRequestSampled,
} from "@/utils/request-sampling";
import { timeRequestDependency } from "@/utils/request-metrics";
import { sleep } from "@/utils/sleep";

// The per-user Gmail limit for this Google Cloud project, shared by every
// route, tab, device and job of one account.
// https://developers.google.com/workspace/gmail/api/reference/quota
export const GMAIL_USER_UNITS_PER_MINUTE = 15_000;

// What Google refuses follows an account's own units over the last minute or
// two rather than its busiest second. So each account has its own per-minute
// budget, which the bucket refills at. It starts at 80% of the limit, about
// what Gmail counted when the gate started at a third: the gate then priced
// every read at 20 units while Gmail charged a full one 60. A full bucket and
// a minute of refill stay under the limit. A refusal for volume cuts it to
// 85% of what the gate let through in the minute before, never below
// `floor`; each ten minutes without one raise it a tenth, up to 80% of the
// limit again.
const BUCKET_CAPACITY = 2000;
const BUDGET = {
  start: GMAIL_USER_UNITS_PER_MINUTE * 0.8,
  max: GMAIL_USER_UNITS_PER_MINUTE * 0.8,
  floor: 1200,
  cutFraction: 0.85,
  raiseFactor: 1.1,
  raiseEveryMs: 10 * 60_000,
};
const TRAILING_WINDOW_MS = 60_000;
// What each priority must leave in the bucket after its debit: sync leaves
// a person a page of the inbox or several thread opens, and still finds a
// first sync's first page (a screen of whole messages, about 725 units) in a
// full bucket; background leaves more, so it only runs on capacity nobody
// else is using.
const FLOOR: Record<GmailQuotaPriority, number> = {
  interactive: 0,
  sync: 800,
  background: 1400,
};
// Any one second admits at most `PACE_CAP` units in all, a short burst of two
// to three times the limit's minute spread evenly, which Gmail's moving
// average allows; the bucket, not this, bounds what an account spends over
// time.
// Each priority may fill the second up to its own level: sync leaves
// interactive calls room, and background only runs below sync's level, so
// it never slows the sync that fills the inbox.
const PACE_WINDOW_MS = 1000;
const PACE_CAP: Record<GmailQuotaPriority, number> = {
  interactive: 700,
  sync: 500,
  background: 250,
};
// For two seconds from when a person's large request arrives, such as an
// assistant search or a page of the inbox, sync drops to a quarter of its
// pace and background waits. It starts on arrival, not admission: otherwise
// sync refills each second before a waiting batch fits. Opening a thread is
// a few reads (a thread in full is 120 units) and starts no episode: the sync
// that fills that thread's older messages keeps its share. A new episode
// starts at most every three seconds, so someone working all the time still
// leaves sync and background one second in three.
const INTERACTIVE_DEMAND_MIN_UNITS = 300;
const INTERACTIVE_DEMAND_MS = 2000;
const INTERACTIVE_DEMAND_EVERY_MS = 3000;
// What sync and background get between two episodes.
const DEMAND_GAP_MS = INTERACTIVE_DEMAND_EVERY_MS - INTERACTIVE_DEMAND_MS;
const PACE_YIELD_CAP = { sync: 120, background: 0 };
const MAX_WAIT_MS: Record<GmailQuotaPriority, number> = {
  interactive: 10_000,
  sync: 15_000,
  background: 15_000,
};
// Refreshed while a primary scan pages through, so a scan that stops clears it.
const INITIAL_SYNC_TTL_MS = 90_000;
const INITIAL_SYNC_REFRESH_MS = 30_000;
// The scan clears the marker the moment it ends, long before it expires, so
// the engine's own backfill comes back this soon instead of waiting out the
// expiry. It never waits inside the gate: the engine's lane would sit on the
// request while the scan that clears the marker waits behind it. Routes and
// queued jobs are told the expiry, so they do not spend their retries early.
const INITIAL_SYNC_RETRY_MS = 5000;
const ENGINE_SCAN_CALLER = "mail/v1/enumeration";
// The REST client retries for seconds; a gate that cannot coordinate within
// this long lets the call through rather than stall every Gmail call.
const STORE_TIMEOUT_MS = 300;
// After Gmail refuses a call, sync and background stand back while
// interactive calls continue. Background then comes back at half its pace
// for ten minutes: at full pace it was refused again about once a minute,
// each time after a pause. Its pause outlasts its longest wait, so jobs come
// back later rather than hold a function open. After Gmail refuses a
// person's call for volume, their calls (the refused one's retry among them)
// also wait five to ten seconds at the gate rather than resend into the same
// refusal.
const INTERACTIVE_PAUSE_MIN_MS = 5000;
const INTERACTIVE_PAUSE_MAX_MS = 10_000;
// A volume refusal names a retry time within a few minutes, if any.
const VOLUME_RETRY_MAX_MS = 5 * 60_000;
const SYNC_PAUSE_MIN_MS = 10_000;
const BACKGROUND_PAUSE_MIN_MS = 20_000;
const BACKGROUND_SLOW_MS = 10 * 60_000;
// Usage hashes expire five minutes after their last write, so a summary can
// still claim the four minutes before the current one.
const SUMMARY_LOOKBACK_MINUTES = 4;
// One store round trip per Gmail call spent most of the Redis plan's monthly
// commands, so each instance shares them within a lane (one account at one
// priority):
// - Calls that arrive while the lane's request is in flight wait for it, and
//   the store admits them in that same round trip while each still fits, by
//   the same rules as one at a time.
// - A lane in steady use reserves what it admitted over the last `LEASE_MS`
//   for the next `LEASE_MS`, and spends it without asking. It reserves only
//   from the half of the second's pace cap and of the bucket that nothing is
//   using, and only while it has not had to wait, so it never holds back
//   another call or a busy lane. A reservation keeps its place in the pace
//   window until its lease ends, so no second carries more than its cap
//   however late it is spent. The one slack is across minutes: units
//   reserved just before a minute can be spent in it. All live reservations
//   fit in half the largest per-second cap, so a minute can carry at most
//   350 units more than the gate debited for it (2.3% of Gmail's 15,000
//   units per user, about 3% of the highest budget).
// - A call whose lane was just told to wait, for a call costing no more, takes
//   that answer for up to `SHARED_WAIT_MS` instead of asking again. This can
//   only make a call wait, never admit it. A round trip that admits also says
//   what the next call would be told (the first waiting call it left out, or
//   one costing the same), so a lane sending one call after another, as a
//   sync page's batches do, waits that out instead of asking only to hear it.
//   A wait the bucket set, unless it defers, is taken for up to
//   `SHARED_BUCKET_WAIT_MS`, since nothing but a budget raise (at most every
//   ten minutes) makes the bucket fill sooner.
// What this instance learns (a refusal, a first sync starting or ending, a
// person's turn) clears its lanes at once; other instances follow within one
// lease. Usage counts and deferrals stay in memory until the account's next
// round trip, or `NOTE_FLUSH_MS`; they only feed the usage summary, so losing
// them loses part of a log line, never protection.
const LEASE_MS = 500;
const LEASE_SHARE = 0.5;
const SHARED_WAIT_MS = 500;
const SHARED_BUCKET_WAIT_MS = 5000;
const BURST_MS = 100;
const NOTE_FLUSH_MS = 2000;
const NOTE_FLUSH_FIELDS = 100;
const GATE_SUMMARY_INTERVAL_MS = 5 * 60_000;

export const GMAIL_QUOTA_PRIORITIES = [
  "interactive",
  "sync",
  "background",
] as const;
export type GmailQuotaPriority = (typeof GMAIL_QUOTA_PRIORITIES)[number];

/** What one unit of work (such as an assistant tool call) met at the gate. */
export type GmailQuotaStats = {
  waitMs: number;
  deferred: number;
  refused: number;
  rateLimitMode: number;
  /** Units of the calls the gate let through to Gmail, retries included. */
  admittedCost: number;
};

type GmailQuotaContext = {
  caller: string;
  priority: GmailQuotaPriority;
  stats?: GmailQuotaStats;
  /** Caps the gate waits of every call in this context together. */
  maxTotalWaitMs?: number;
  /** Told before each Gmail call this context makes, admitted or not. */
  onAdmit?: () => void;
  /**
   * Sync work that still waits for a primary scan to end, as background
   * does: a first sync's older inbox, which must not slow the scan of the
   * newest mail.
   */
  afterInitialSync?: boolean;
};

// Route scopes, matched exactly so a route added under a background path is
// never held back by accident (D-086). Interactive: a person triggered it or
// is looking at it right now: a thread they opened and that thread's summary,
// context and reply suggestion, a message they send, a search they typed, a
// bulk action they clicked, a question they asked the assistant, or the first
// paint of a page they opened. Sync: the mail engine's own reads and the
// provider's push notifications, which keep the mailbox current. Background:
// everything else, so a route nobody listed only spends capacity nobody else
// is using; a user-facing route must be listed as interactive. A route a
// person is waiting on that also fans out raises its own reads to
// interactive, with a wait budget, through runWithGmailQuota.
const ROUTE_PRIORITY = new Map<string, GmailQuotaPriority>([
  ...withPriority("interactive", [
    "labels",
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
    "user/search-intent",
    // The select-all banner waits on it to say how many conversations match.
    "user/mail/matching-count",
    // An open composer waits on it before showing its editor.
    "user/signature",
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
    "user/snoozed-threads",
    // The open thread's summary, context and reply suggestion: the reader
    // only asks for them while the conversation is on screen.
    "user/thread-context",
    "user/thread-brief",
    "user/suggested-reply",
    "user/public-contact-context",
    // Pages and panels a person opened.
    "user/home",
    // The newest inbox mail for the inbox a person came back to.
    "user/inbox-catch-up",
    "user/contacts",
    "user/folders",
    "user/mail-splits",
    "user/vacation-responder",
    "user/meeting-recorder/meeting-draft",
    // The composer's "Share my free times", asked for by the person writing.
    "user/calendar/free-times",
    "labels/counts",
    "/api/labels/create",
    "/api/user/drive/preview",
    "/api/user/drive/preview/attachments",
    // Connecting an account: the person waits on the redirect.
    "google/linking/callback",
    // A server-rendered page that waits on Gmail.
    "clean/onboarding",
    "outlook/linking/callback",
    // Another assistant's tool call, asked for by the person using it.
    "mcp-server",
  ]),
  ...withPriority("sync", [
    "mail/v1/bootstrap",
    "mail/v1/capabilities",
    "mail/v1/changes",
    "mail/v1/changes-batch",
    "mail/v1/enumeration",
    "mail/v1/hydration",
    "mail/v1/scopes",
    "mobile/mailbox-sync",
    "google/webhook",
    "google/webhook/catch-up",
    "outlook/webhook",
    "watch",
    "watch/all",
    "watch/resume",
    "/api/watch/unwatch",
    // Continues a sender archive a person started, once a deferral passes.
    "user/senders/archive-existing",
    // What a person scheduled, due now.
    "scheduled-actions/execute",
    "snoozed-threads/execute",
    // Summarizing mail a person's own digest rule picked.
    "digest",
    // A durable send it delivers raises itself to interactive.
    "scheduled-emails/execute",
    // Push for an account just signed in or linked.
    "auth/link-watch",
  ]),
  ...withPriority("background", [
    "user/inbox-insights",
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
    // Acting on every conversation a view matches; the person sees progress
    // and can leave, so it only spends capacity nobody else is using.
    "mail/bulk-matching",
  ]),
]);

const quotaContext = new AsyncLocalStorage<GmailQuotaContext>();
const logger = createScopedLogger("gmail-quota");
const accountsByToken = new Map<string, string>();
// Accounts this instance metered, with the latest minute it did so, kept
// until that minute has ended and been summarized.
const unsummarizedAccounts = new Map<string, number>();
const summaryCheckedMinute = new Map<string, number>();
// When this instance last warned about each account's store, in epoch ms.
const storeWarnedAt = new Map<string, number>();
const STORE_WARNING_INTERVAL_MS = 60_000;
const initialSyncMarkedAt = new Map<string, number>();
let gateOffReported = false;
const unattributedCallers = new Set<string>();

type LaneWaiter = {
  cost: number;
  field: string;
  outcome: "admitted" | "unavailable" | null;
  error?: unknown;
};
type Lane = {
  leases: {
    units: number;
    total: number;
    reservation: string | null;
    from: number;
    until: number;
    lastSpentAt: number | null;
  }[];
  /** Units this instance admitted on the lane recently, to size a lease. */
  recent: { at: number; units: number }[];
  inflight: Promise<void> | null;
  queue: LaneWaiter[];
  waitedAt: number | null;
  /** The latest wait the store gave, by blocker variant. */
  waits: Map<
    string,
    {
      from: number;
      until: number;
      cost: number;
      defer: boolean;
      held: GmailQuotaHold | undefined;
    }
  >;
};
const lanes = new Map<string, Lane>();
const pendingNotes = new Map<string, Map<string, Map<string, number>>>();
// Reservations this instance gave up early, cut down with the account's next
// round trip; one that no request carries in time simply ages out.
const pendingReleases = new Map<
  string,
  { reservation: string; kept: number; soonerMs: number; until: number }[]
>();
let pendingNoteFields = 0;
let pendingNotesSince: number | null = null;
const gateStats = {
  calls: 0,
  storeTakes: 0,
  leaseAdmissions: 0,
  batchedAdmissions: 0,
  sharedWaits: 0,
  leasedUnits: 0,
  unspentLeaseUnits: 0,
  noteFlushes: 0,
  notesFlushed: 0,
};
// Every deferral is counted here; only a sample gets its own log line.
const deferralCounts = new Map<string, number>();
let gateStatsSince = Date.now();

export type GmailDeferralReason =
  | "interactive_pause"
  | "sync_pause"
  | "background_pause"
  | "initial_sync_scan"
  | "per_minute_budget"
  | "per_second_pace"
  | "interactive_demand_yield"
  | "unknown";

export class GmailCallDeferredError extends Error {
  readonly code = "GMAIL_CALL_DEFERRED";
  readonly retryAfterMs: number;
  readonly priority: GmailQuotaPriority;
  readonly reason: GmailDeferralReason;
  constructor(
    retryAfterMs: number,
    priority: GmailQuotaPriority,
    reason: GmailDeferralReason = "unknown",
  ) {
    super(
      `Gmail call deferred for ${Math.ceil(retryAfterMs / 1000)}s to keep the account within its per-minute Gmail budget`,
    );
    this.name = "GmailCallDeferredError";
    this.retryAfterMs = Math.max(1000, Math.ceil(retryAfterMs));
    this.priority = priority;
    this.reason = reason;
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
    onAdmit?: () => void;
    afterInitialSync?: boolean;
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
      onAdmit: context.onAdmit ?? current.onAdmit,
      afterInitialSync: context.afterInitialSync ?? current.afterInitialSync,
    },
    operation,
  );
}

// What the open thread's summary, context and reply suggestion wait at the
// gate in all before they answer 503 with a retry time: the reader shows
// what it has, and the browser asks again once, rather than a request
// holding on for most of a minute.
export const OPEN_THREAD_GMAIL_WAIT_MS = 4000;

/**
 * Caps how long all of `operation`'s Gmail calls wait at the gate together,
 * at `priority` (the current one by default), so a request someone is
 * waiting on answers or defers (with its retry time) within
 * `maxTotalWaitMs` instead of queueing one call after another for most of
 * a minute.
 */
export function runWithGmailWaitBudget<T>(
  maxTotalWaitMs: number,
  operation: () => T,
  { priority }: { priority?: GmailQuotaPriority } = {},
): T {
  const current = currentGmailQuotaContext();
  return runWithGmailQuota(
    {
      priority: priority ?? current.priority,
      maxTotalWaitMs,
      stats: current.stats ?? createGmailQuotaStats(),
    },
    operation,
  );
}

/**
 * Runs a request's own work at `priority`. Nobody waits on what it leaves
 * running once it settles, such as `after()` callbacks, so that drops to
 * background and cannot hold the bucket down while sync and webhooks wait.
 */
export async function runGmailQuotaRequest<T>(
  context: GmailQuotaContext,
  operation: () => Promise<T>,
): Promise<T> {
  const store: GmailQuotaContext = { ...context };
  try {
    return await quotaContext.run(store, operation);
  } finally {
    store.priority = "background";
  }
}

export function createGmailQuotaStats(): GmailQuotaStats {
  return {
    waitMs: 0,
    deferred: 0,
    refused: 0,
    rateLimitMode: 0,
    admittedCost: 0,
  };
}

/** Counts a call skipped because the account is in provider rate-limit mode. */
export function noteRateLimitModeSkip() {
  const stats = quotaContext.getStore()?.stats;
  if (stats) stats.rateLimitMode += 1;
}

export function currentGmailQuotaContext(): GmailQuotaContext {
  const explicit = quotaContext.getStore();
  if (explicit) return { ...explicit };
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
    return await timeRequestDependency("gmail", operation);
  } catch (error) {
    if (isGmailQuotaRefusal(error)) await noteGmailQuotaRefusal(ticket, error);
    throw error;
  }
}

export type GmailQuotaTicket = {
  emailAccountId: string | undefined;
  caller: string;
  priority: GmailQuotaPriority;
  /** Sync held behind the primary scan, which a refusal treats as background. */
  afterInitialSync?: boolean;
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
  context.onAdmit?.();
  const afterInitialSync = priority === "sync" && !!context.afterInitialSync;
  const ticket: GmailQuotaTicket = {
    emailAccountId,
    caller: context.caller,
    priority,
    ...(afterInitialSync && { afterInitialSync }),
  };
  const admitted = () => {
    if (context.stats) context.stats.admittedCost += cost;
    return ticket;
  };
  if (!isEmailProviderRateLimitRedisConfigured()) {
    reportGateOff();
    return admitted();
  }
  if (!emailAccountId) {
    reportUnattributed(context.caller);
    return admitted();
  }

  rememberUnsummarizedAccount(emailAccountId);
  gateStats.calls += 1;
  const keys = accountKeys(emailAccountId);
  const scanHold =
    context.caller === ENGINE_SCAN_CALLER
      ? { key: keys.initialSync, deferMs: INITIAL_SYNC_RETRY_MS }
      : { key: keys.initialSync };
  const blockers = {
    interactive: [{ key: keys.interactivePause }],
    // After a refusal it stands back as background does, which is all its
    // own refusal pauses.
    sync: afterInitialSync
      ? [{ key: keys.syncPause }, scanHold, { key: keys.backgroundPause }]
      : [{ key: keys.syncPause }],
    background: [scanHold, { key: keys.backgroundPause }],
  }[priority];
  const blockerReasons: GmailDeferralReason[] = {
    interactive: ["interactive_pause" as const],
    sync: [
      "sync_pause" as const,
      "initial_sync_scan" as const,
      "background_pause" as const,
    ],
    background: ["initial_sync_scan" as const, "background_pause" as const],
  }[priority];
  const { stats, maxTotalWaitMs } = context;
  const deadline = Math.min(
    Date.now() +
      Math.min(
        MAX_WAIT_MS[priority],
        maxTotalWaitMs === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, maxTotalWaitMs - (stats?.waitMs ?? 0)),
      ),
    getRequestDeadline() ?? Number.POSITIVE_INFINITY,
  );
  // A person's large request starts a demand episode as it arrives, which
  // only the store can do, so it never rides on the lane. Nor does sync
  // that waits for the primary scan: the scan's own reservation on the sync
  // lane would admit it past that hold.
  const startsDemand =
    priority === "interactive" && cost >= INTERACTIVE_DEMAND_MIN_UNITS;
  const lane =
    startsDemand || afterInitialSync ? null : laneFor(emailAccountId, priority);
  // What sync and background hold here would only delay it; their unspent
  // reservations are cut with its own round trip.
  if (startsDemand) forgetLanes(emailAccountId, ["sync", "background"]);

  const waitKey = context.caller === ENGINE_SCAN_CALLER ? "scan" : "";
  const usageField = `${priority}:${context.caller}`;
  const admittedHere = () => {
    queueNote(
      emailAccountId,
      keys.usage(minuteOf(Date.now())),
      usageField,
      cost,
    );
    if (lane) noteLaneUnits(lane, cost);
    return admitted();
  };
  for (;;) {
    let admission: {
      waitMs: number;
      defer: boolean;
      held?: GmailQuotaHold;
    } | null = null;
    if (lane) {
      if (spendLease(lane, cost)) {
        gateStats.leaseAdmissions += 1;
        return admittedHere();
      }
      if (lane.inflight) {
        const waiter: LaneWaiter = { cost, field: usageField, outcome: null };
        lane.queue.push(waiter);
        await lane.inflight;
        if (waiter.outcome === "admitted") {
          // The store recorded its units with the request it rode on.
          gateStats.batchedAdmissions += 1;
          noteLaneUnits(lane, cost);
          return admitted();
        }
        if (waiter.outcome === "unavailable") {
          noteStoreUnavailable(emailAccountId, context.caller, waiter.error);
          return admitted();
        }
        continue;
      }
      admission = sharedWait(lane, waitKey, cost);
      if (admission) {
        gateStats.sharedWaits += 1;
        lane.waitedAt = Date.now();
      }
    }
    if (!admission) {
      const usageKey = keys.usage(minuteOf(Date.now()));
      const request = {
        bucketKey: keys.bucket,
        usageKey,
        usageField,
        blockers,
        cost,
        capacity: BUCKET_CAPACITY,
        budget: {
          key: keys.budget,
          trailingKey: keys.trailing,
          trailingWindowMs: TRAILING_WINDOW_MS,
          start: BUDGET.start,
          max: BUDGET.max,
          raiseFactor: BUDGET.raiseFactor,
          raiseEveryMs: BUDGET.raiseEveryMs,
        },
        floor: FLOOR[priority],
        waitBudgetMs: Number.isFinite(deadline)
          ? Math.max(0, deadline - Date.now())
          : undefined,
        pace: {
          key: keys.pace,
          cap: PACE_CAP[priority],
          windowMs: PACE_WINDOW_MS,
          slowKey: priority === "background" ? keys.backgroundSlow : undefined,
          demand:
            priority !== "interactive"
              ? {
                  key: keys.interactiveDemand,
                  yieldCap: PACE_YIELD_CAP[priority],
                }
              : cost >= INTERACTIVE_DEMAND_MIN_UNITS
                ? {
                    key: keys.interactiveDemand,
                    markMs: INTERACTIVE_DEMAND_MS,
                    everyMs: INTERACTIVE_DEMAND_EVERY_MS,
                  }
                : { key: keys.interactiveDemand },
        },
      };
      try {
        admission = lane
          ? await takeForLane(lane, request, {
              emailAccountId,
              waitKey,
              // A person's large request needs an empty second, which an
              // interactive lane's own unspent reservation would hold up.
              aheadCap: priority === "interactive" ? 0 : PACE_CAP[priority],
            })
          : await takeFromStore(request, emailAccountId);
      } catch (error) {
        // Without the shared store nothing can be coordinated; Gmail's own
        // limit still protects the account, so the call goes ahead.
        noteStoreUnavailable(emailAccountId, context.caller, error);
        return admitted();
      }
    }
    const wait = admission.waitMs;
    if (wait === 0) {
      if (lane) noteLaneUnits(lane, cost);
      return admitted();
    }
    if (admission.defer || Date.now() + wait > deadline) {
      queueNote(
        emailAccountId,
        keys.usage(minuteOf(Date.now())),
        `deferred:${context.caller}`,
        1,
      );
      if (stats) stats.deferred += 1;
      const error = new GmailCallDeferredError(
        wait,
        priority,
        deferralReason(admission.held, blockerReasons),
      );
      logDeferral({
        error,
        emailAccountId,
        caller: context.caller,
        cost,
        waitMs: wait,
        heldByStore: admission.defer,
        waitBudgetMs: Number.isFinite(deadline)
          ? Math.max(0, deadline - Date.now())
          : null,
        held: admission.held,
        floor: FLOOR[priority],
        paceCap: PACE_CAP[priority],
      });
      throw error;
    }
    const sleepMs = Math.min(wait, deadline - Date.now());
    await timeRequestDependency("wait", () => sleep(sleepMs));
    if (stats) stats.waitMs += sleepMs;
  }
}

/**
 * Gmail refused a call for quota. Background work pauses, and a refusal of
 * anything else also pauses sync. When the refusal is for the minute's
 * volume, the account's budget also drops to what Gmail just accepted,
 * background runs at half its pace for a while, and a refused interactive
 * call holds interactive calls for a few seconds; otherwise they keep going.
 */
export async function noteGmailQuotaRefusal(
  ticket: GmailQuotaTicket,
  error?: unknown,
) {
  const stats = quotaContext.getStore()?.stats;
  if (stats) stats.refused += 1;
  if (!ticket.emailAccountId || !isEmailProviderRateLimitRedisConfigured())
    return;
  forgetLanes(ticket.emailAccountId, GMAIL_QUOTA_PRIORITIES);
  const keys = accountKeys(ticket.emailAccountId);
  // A volume refusal says the account sent too much this minute; anything
  // else (too many requests at once, a daily sending limit, a retry time
  // far off) says nothing about the minute, so it neither cuts the budget
  // nor holds a person's reads, and its retry time is not waited out here.
  const volume = isVolumeRefusal(error);
  const retryAfterMs = volume ? (retryAfterFromMessage(error) ?? 0) : 0;
  const writes: Promise<unknown>[] = [
    gmailQuotaStore.block({
      key: keys.backgroundPause,
      ms: Math.max(BACKGROUND_PAUSE_MIN_MS, retryAfterMs),
    }),
    gmailQuotaStore.note([
      {
        usageKey: keys.usage(minuteOf(Date.now())),
        field: `refused:${ticket.caller}`,
        amount: 1,
      },
    ]),
  ];
  // A first sync's older inbox reads at sync but stands back like the
  // backfill it is: its refusal must not hold webhooks and live changes for
  // up to a refusal's retry time.
  if (ticket.priority !== "background" && !ticket.afterInitialSync)
    writes.push(
      gmailQuotaStore.block({
        key: keys.syncPause,
        ms: Math.max(SYNC_PAUSE_MIN_MS, retryAfterMs),
      }),
    );
  if (volume) {
    writes.push(
      gmailQuotaStore.block({
        key: keys.backgroundSlow,
        ms: BACKGROUND_SLOW_MS,
      }),
      gmailQuotaStore.cutBudget({
        key: keys.budget,
        trailingKey: keys.trailing,
        trailingWindowMs: TRAILING_WINDOW_MS,
        start: BUDGET.start,
        fraction: BUDGET.cutFraction,
        floor: BUDGET.floor,
      }),
    );
    if (ticket.priority === "interactive")
      writes.push(
        gmailQuotaStore.block({
          key: keys.interactivePause,
          ms: Math.min(
            INTERACTIVE_PAUSE_MAX_MS,
            Math.max(INTERACTIVE_PAUSE_MIN_MS, retryAfterMs),
          ),
        }),
      );
  }
  const results = await Promise.allSettled(writes.map(withinStoreTimeout));
  for (const result of results)
    if (result.status === "rejected")
      logger.warn("Failed to record Gmail quota refusal", {
        error: result.reason,
      });
}

/**
 * A Gmail refusal that says nothing about the account's volume this minute:
 * too many requests at once, a sending limit, or a retry time more than a
 * few minutes away. Nothing that reads mail should wait it out.
 */
export function isGmailNonVolumeRefusal(error: unknown) {
  const { errorMessage } = extractErrorInfo(error);
  if (/too many concurrent requests/i.test(errorMessage)) return true;
  if (/mail sending/i.test(errorMessage)) return true;
  return (retryAfterFromMessage(error) ?? 0) > VOLUME_RETRY_MAX_MS;
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
 * The most units one Gmail request at `priority` should carry. Half its
 * per-second cap lets a request in while the second holds other traffic,
 * instead of waiting for a quiet second that steady sync never leaves.
 */
export function gmailRequestUnitsFor(priority: GmailQuotaPriority) {
  return PACE_CAP[priority] / 2;
}

/**
 * The most units work at `priority` can spend from a full bucket without
 * waiting for it to refill. Work that costs more sleeps in the gate for the
 * difference at the budget's refill rate.
 */
export function gmailBurstUnitsFor(priority: GmailQuotaPriority) {
  return BUCKET_CAPACITY - FLOOR[priority];
}

/**
 * Holds sync and background back, as one large interactive request does for
 * two seconds, for as long as someone waits on a longer piece of work such as
 * an assistant turn, up to `maxMs` so a turn that never ends can't starve
 * sync. Call the returned function when the work ends.
 */
export async function holdGmailInteractiveDemand(
  emailAccountId: string,
  maxMs: number,
): Promise<() => Promise<void>> {
  const done = async () => {};
  if (!isEmailProviderRateLimitRedisConfigured()) return done;
  const key = accountKeys(emailAccountId).interactiveDemand;
  forgetLanes(emailAccountId, ["sync", "background"]);
  try {
    const endsAt = await withinStoreTimeout(
      gmailQuotaStore.holdDemand({ key, ms: maxMs, gapMs: DEMAND_GAP_MS }),
    );
    if (!endsAt) return done;
    return async () => {
      forgetLanes(emailAccountId, ["sync", "background"]);
      await withinStoreTimeout(
        gmailQuotaStore.releaseDemand({ key, endsAt, gapMs: DEMAND_GAP_MS }),
      ).catch((error) => {
        logger.warn("Failed to release Gmail interactive demand", { error });
      });
    };
  } catch (error) {
    logger.warn("Failed to hold Gmail interactive demand", { error });
    return done;
  }
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
  forgetLanes(emailAccountId, ["background"]);
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
 * Logs the "Gmail quota usage" summary of each account this instance metered,
 * for every minute that has ended and that no instance has logged yet. Runs
 * when a request flushes its logs: a serverless instance may never run again
 * once its response is sent, so neither a timer nor the account's next Gmail
 * call can be relied on to report a minute.
 */
export async function logGmailQuotaUsage() {
  logGateSummary();
  // A request's end may be the instance's last moment. Notes written with a
  // summary claim below are taken first; this writes whatever is left.
  if (unsummarizedAccounts.size === 0) {
    if (pendingNoteFields > 0) await flushNotes();
    return;
  }
  const minute = minuteOf(Date.now());
  await Promise.all(
    [...unsummarizedAccounts].map(async ([emailAccountId, lastMinute]) => {
      if (summaryCheckedMinute.get(emailAccountId) === minute) return;
      summaryCheckedMinute.delete(emailAccountId);
      summaryCheckedMinute.set(emailAccountId, minute);
      trimOldest(summaryCheckedMinute);
      if (lastMinute < minute) unsummarizedAccounts.delete(emailAccountId);
      try {
        await summarizeEndedMinutes(emailAccountId, minute);
      } catch (error) {
        // A store timeout that already warned for this account within the
        // minute (as when the same slow reply failed an admission) is not
        // warned about again. Any other failure always warns.
        const log =
          error instanceof StoreTimeoutError &&
          !claimStoreWarning(emailAccountId)
            ? logger.info
            : logger.warn;
        log("Failed to summarize Gmail quota usage", { emailAccountId, error });
      }
    }),
  );
  if (pendingNoteFields > 0) await flushNotes();
}

/**
 * Forgets what this instance holds outside the store (leases, waits it was
 * told, unwritten usage counts), as a fresh instance would start. For tests
 * that reset the store between cases.
 */
export function resetGmailQuotaInstanceState() {
  lanes.clear();
  unsummarizedAccounts.clear();
  summaryCheckedMinute.clear();
  pendingNotes.clear();
  pendingReleases.clear();
  pendingNoteFields = 0;
  pendingNotesSince = null;
}

/**
 * What the gate charges one Gmail REST call, from its HTTP method and URL,
 * whose `format` query parameter decides what a read costs. These are Cue's
 * own conservative units, modelled on Google's published costs: a full, raw
 * or html read at three times a metadata or minimal one. Unknown calls are
 * charged like a write so they are never undercounted.
 */
export function gmailRequestCost(method: string, url: string | URL): number {
  const parsed = typeof url === "string" ? new URL(url, "https://x") : url;
  const match = parsed.pathname.match(/\/gmail\/v1\/users\/[^/]+(\/.*)?$/);
  // Gmail reads a message, thread or draft in full when no format is given;
  // a full read is charged three times a lighter one.
  const format = parsed.searchParams.get("format")?.toLowerCase() ?? "full";
  const fullRead = format === "full" || format === "raw" || format === "html";
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
    if (verb === "DELETE") return 10;
    return verb === "GET" && fullRead ? 60 : 20;
  }
  if (resource === "threads") {
    if (!id) return 10;
    if (action === "modify" || action === "untrash") return 10;
    if (action === "trash") return 20;
    if (verb === "DELETE") return 20;
    return verb === "GET" && fullRead ? 120 : 40;
  }
  if (resource === "drafts") {
    if (!id) return verb === "GET" ? 5 : 10;
    if (id === "send") return 100;
    if (verb === "GET") return fullRead ? 60 : 20;
    if (verb === "DELETE") return 10;
    return 15;
  }
  return 20;
}

export function deferralReason(
  held: GmailQuotaHold | undefined,
  blockerReasons: GmailDeferralReason[],
): GmailDeferralReason {
  if (!held) return "unknown";
  if (held.gate === "blocker")
    return blockerReasons[held.blocker - 1] ?? "unknown";
  if (held.gate === "bucket") return "per_minute_budget";
  if (held.gate === "pace") return "per_second_pace";
  if (held.gate === "interactive_demand") return "interactive_demand_yield";
  return "unknown";
}

function logDeferral({
  error,
  emailAccountId,
  caller,
  cost,
  waitMs,
  heldByStore,
  waitBudgetMs,
  held,
  floor,
  paceCap,
}: {
  error: GmailCallDeferredError;
  emailAccountId: string;
  caller: string;
  cost: number;
  waitMs: number;
  heldByStore: boolean;
  waitBudgetMs: number | null;
  held: GmailQuotaHold | undefined;
  floor: number;
  paceCap: number;
}) {
  const deferredBy = heldByStore ? "store_hold" : "wait_budget";
  const countKey = [error.reason, deferredBy, error.priority, caller].join("|");
  if (deferralCounts.size < 200 || deferralCounts.has(countKey))
    deferralCounts.set(countKey, (deferralCounts.get(countKey) ?? 0) + 1);
  const { requestId, source } = getAuditContext();
  // A person is waiting on an interactive deferral, so every one ships.
  const sampleRate =
    error.priority === "interactive" ? 1 : getFastRequestSampleRate(source);
  const sampled = isFastRequestSampled(requestId ?? randomUUID(), sampleRate);
  (sampled ? logger.info : logger.trace).call(logger, "Gmail call deferred", {
    emailAccountId,
    requestId,
    sampled,
    sampleRate,
    route: caller,
    waitMs,
    reason: error.reason,
    // "store_hold" is a pause the gate told callers not to wait on; otherwise
    // the wait was longer than the caller could spend.
    deferredBy,
    priority: error.priority,
    caller,
    retryAfterMs: error.retryAfterMs,
    waitBudgetMs,
    cost,
    availableUnits: held?.availableUnits,
    neededUnits: held?.neededUnits,
    floorUnits: floor,
    paceUsedUnits: held?.paceUnits,
    paceCapUnits: paceCap,
  });
}

function priorityForCaller(caller: string): GmailQuotaPriority {
  const routePriority = ROUTE_PRIORITY.get(caller);
  if (routePriority) return routePriority;
  return "background";
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

async function summarizeEndedMinutes(
  emailAccountId: string,
  currentMinute: number,
) {
  const keys = accountKeys(emailAccountId);
  const minutes = Array.from(
    { length: SUMMARY_LOOKBACK_MINUTES },
    (_, index) => currentMinute - SUMMARY_LOOKBACK_MINUTES + index,
  );
  const notes = takeNotes(emailAccountId);
  const usages = await withinStoreTimeout(
    gmailQuotaStore.claimUsages(
      minutes.map((minute) => ({
        usageKey: keys.usage(minute),
        claimKey: `${keys.usage(minute)}:logged`,
      })),
      notes,
    ),
  ).catch((error) => {
    requeueUnlessTimedOut(emailAccountId, notes, error);
    throw error;
  });
  minutes.forEach((minute, index) => {
    const usage = usages[index];
    if (usage && Object.keys(usage).length > 0)
      logMinuteUsage(emailAccountId, minute, usage);
  });
}

// Callers are data, so each breakdown is a list rather than an object keyed by
// caller: Axiom gives every key path its own column.
function logMinuteUsage(
  emailAccountId: string,
  minute: number,
  usage: Record<string, number>,
) {
  const unitsByCaller: { priority: string; caller: string; units: number }[] =
    [];
  const deferredByCaller: { caller: string; calls: number }[] = [];
  const refusedByCaller: { caller: string; calls: number }[] = [];
  const storeUnavailableByCaller: { caller: string; calls: number }[] = [];
  let peakSecondUnits = 0;
  let budgetUnits: number | undefined;
  for (const [field, value] of Object.entries(usage)) {
    if (field === "peak:second") {
      peakSecondUnits = value;
      continue;
    }
    if (field === "budget:perMinute") {
      budgetUnits = value;
      continue;
    }
    const separator = field.indexOf(":");
    const kind = field.slice(0, separator);
    const caller = field.slice(separator + 1);
    if (kind === "deferred") deferredByCaller.push({ caller, calls: value });
    else if (kind === "refused") refusedByCaller.push({ caller, calls: value });
    else if (kind === "unavailable")
      storeUnavailableByCaller.push({ caller, calls: value });
    else unitsByCaller.push({ priority: kind, caller, units: value });
  }
  logger.info("Gmail quota usage", {
    emailAccountId,
    minute: new Date(minute * 60_000).toISOString(),
    totalUnits: sumOf(unitsByCaller.map((entry) => entry.units)),
    limitUnits: GMAIL_USER_UNITS_PER_MINUTE,
    // The account's self-tuned budget at its last admission that minute.
    budgetUnits,
    // The most units admitted within any one second of the minute.
    peakSecondUnits,
    // The highest per-second cap of any priority, so health checks can tell a
    // pinned second without hardcoding the cap.
    peakSecondCapUnits: Math.max(...Object.values(PACE_CAP)),
    unitsByCaller: unitsByCaller.sort((a, b) => b.units - a.units),
    deferredByCaller,
    refusedByCaller,
    // Calls admitted without the gate because its store failed or was slow.
    storeUnavailableCalls: sumOf(
      storeUnavailableByCaller.map((entry) => entry.calls),
    ),
    storeUnavailableByCaller,
  });
}

function sumOf(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0);
}

function rememberUnsummarizedAccount(emailAccountId: string) {
  unsummarizedAccounts.delete(emailAccountId);
  unsummarizedAccounts.set(emailAccountId, minuteOf(Date.now()));
  trimOldest(unsummarizedAccounts);
}

function trimOldest(map: Map<string, unknown>) {
  if (map.size <= 1000) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}

// Without Redis nothing paces Gmail calls, which against real Google ends in
// per-minute refusals for whole accounts. The emulator has no such limit.
function reportGateOff() {
  if (gateOffReported || env.GOOGLE_BASE_URL) return;
  gateOffReported = true;
  logger.error(
    "Gmail quota gate is off: real Google is configured but Redis is not, so Gmail calls are not paced",
  );
}

// A call that names no account draws on no account's budget, so Gmail can
// refuse that account for traffic the gate never saw.
function reportUnattributed(caller: string) {
  if (unattributedCallers.has(caller)) return;
  unattributedCallers.add(caller);
  logger.warn("Gmail call admitted without an account", { caller });
}

/**
 * A call the gate let through without its store. Warned at most once a minute
 * per account on each instance, and counted into the account's usage summary
 * so a store that keeps timing out shows up instead of silently switching the
 * gate off. The count usually still lands: a slow store finishes the write
 * after the gate stopped waiting.
 */
function noteStoreUnavailable(
  emailAccountId: string,
  caller: string,
  error: unknown,
) {
  const minute = minuteOf(Date.now());
  if (claimStoreWarning(emailAccountId)) {
    logger.warn("Gmail quota store unavailable", { emailAccountId, error });
  }
  queueNote(
    emailAccountId,
    accountKeys(emailAccountId).usage(minute),
    `unavailable:${caller}`,
    1,
  );
}

// One slow store reply can fail both a call's admission and the request's
// usage summary; a store warning per account per minute says it once.
function claimStoreWarning(emailAccountId: string) {
  const now = Date.now();
  const last = storeWarnedAt.get(emailAccountId);
  if (last !== undefined && now - last < STORE_WARNING_INTERVAL_MS) {
    return false;
  }
  storeWarnedAt.delete(emailAccountId);
  storeWarnedAt.set(emailAccountId, now);
  if (storeWarnedAt.size > 1000) {
    const oldest = storeWarnedAt.keys().next().value;
    if (oldest) storeWarnedAt.delete(oldest);
  }
  return true;
}

function rememberInitialSyncMark(emailAccountId: string) {
  initialSyncMarkedAt.delete(emailAccountId);
  initialSyncMarkedAt.set(emailAccountId, Date.now());
  if (initialSyncMarkedAt.size > 1000) {
    const oldest = initialSyncMarkedAt.keys().next().value;
    if (oldest) initialSyncMarkedAt.delete(oldest);
  }
}

type TakeRequest = Omit<
  Parameters<typeof gmailQuotaStore.take>[0],
  "queued" | "ahead" | "notes"
>;

async function takeFromStore(
  request: TakeRequest,
  emailAccountId: string,
  extra: Pick<
    Parameters<typeof gmailQuotaStore.take>[0],
    "queued" | "ahead"
  > = {},
) {
  gateStats.storeTakes += 1;
  const notes = takeNotes(emailAccountId, request.usageKey);
  const now = Date.now();
  const releases = (pendingReleases.get(emailAccountId) ?? []).filter(
    (entry) => entry.until > now,
  );
  pendingReleases.delete(emailAccountId);
  try {
    return await withinStoreTimeout(
      gmailQuotaStore.take({
        ...request,
        ...extra,
        notes: notes.map(({ field, amount }) => ({ field, amount })),
        release: releases.map(({ reservation, kept, soonerMs }) => ({
          reservation,
          kept,
          soonerMs,
        })),
      }),
    );
  } catch (error) {
    requeueUnlessTimedOut(emailAccountId, notes, error);
    if (!(error instanceof StoreTimeoutError) && releases.length > 0)
      pendingReleases.set(emailAccountId, releases);
    throw error;
  }
}

// A refused request wrote nothing; one that timed out may still land.
function requeueUnlessTimedOut(
  emailAccountId: string,
  notes: GmailQuotaNote[],
  error: unknown,
) {
  if (error instanceof StoreTimeoutError) return;
  for (const note of notes)
    queueNote(emailAccountId, note.usageKey, note.field, note.amount);
}

/**
 * Takes for a lane: callers that arrive while this is in flight wait for it,
 * and those already waiting when it is sent are admitted with it if they fit.
 */
async function takeForLane(
  lane: Lane,
  request: TakeRequest,
  {
    emailAccountId,
    waitKey,
    aheadCap,
  }: { emailAccountId: string; waitKey: string; aheadCap: number },
) {
  let release = () => {};
  lane.inflight = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // Calls made together, as a request fanning out its reads, all reach the
    // gate before this resumes.
    await Promise.resolve();
    const queued = [...lane.queue];
    // A lane that has had to wait is using all it may; units reserved ahead
    // would only hold window time it could have spent.
    const expected =
      aheadCap === 0 ||
      (lane.waitedAt !== null && Date.now() - lane.waitedAt < 2 * LEASE_MS)
        ? 0
        : recentLaneUnits(lane);
    const sentAt = Date.now();
    const result = await takeFromStore(request, emailAccountId, {
      queued: queued.map(({ cost, field }) => ({ cost, field })),
      ahead:
        expected > 0
          ? {
              units: Math.min(
                aheadCap,
                Math.ceil(expected / request.cost) * request.cost,
              ),
              step: request.cost,
              leaseMs: LEASE_MS,
              share: LEASE_SHARE,
            }
          : undefined,
    });
    for (const waiter of queued.slice(0, result.queued))
      waiter.outcome = "admitted";
    if (result.ahead > 0) {
      lane.leases.push({
        units: result.ahead,
        total: result.ahead,
        reservation: result.reservation,
        from: sentAt,
        until: sentAt + LEASE_MS,
        lastSpentAt: null,
      });
      gateStats.leasedUnits += result.ahead;
    }
    if (result.waitMs > 0) {
      lane.waitedAt = sentAt;
      lane.waits.set(waitKey, {
        from: sentAt,
        until: sentAt + result.waitMs,
        cost: request.cost,
        defer: result.defer,
        held: result.held,
      });
    } else if (
      result.nextWait &&
      !request.blockers.some((blocker) => blocker.deferMs)
    ) {
      // What the store would tell the next call, as if it had asked itself.
      // A caller a marker defers (the engine's backfill) keeps asking, so it
      // never waits inside the gate while one is up.
      lane.waits.set(waitKey, {
        from: sentAt,
        until: sentAt + result.nextWait.waitMs,
        cost: queued[result.queued]?.cost ?? request.cost,
        defer: false,
        held: result.nextWait.held,
      });
    }
    return result;
  } catch (error) {
    for (const waiter of lane.queue) {
      waiter.outcome = "unavailable";
      waiter.error = error;
    }
    throw error;
  } finally {
    lane.inflight = null;
    lane.queue = [];
    release();
  }
}

function laneFor(emailAccountId: string, priority: GmailQuotaPriority) {
  const key = `${emailAccountId}:${priority}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      leases: [],
      recent: [],
      inflight: null,
      queue: [],
      waitedAt: null,
      waits: new Map(),
    };
    lanes.set(key, lane);
    if (lanes.size > 3000)
      for (const [oldestKey, oldest] of lanes)
        if (!oldest.inflight) {
          lanes.delete(oldestKey);
          break;
        }
  }
  return lane;
}

/** Pays `cost` from the lane's live leases, if they hold that much. */
function spendLease(lane: Lane, cost: number) {
  const now = Date.now();
  lane.leases = lane.leases.filter((lease) => {
    const live = lease.from <= now && now < lease.until;
    if (!live) gateStats.unspentLeaseUnits += lease.units;
    return live;
  });
  const available = lane.leases.reduce((sum, lease) => sum + lease.units, 0);
  if (available < cost) return false;
  let owed = cost;
  for (const lease of lane.leases) {
    const paid = Math.min(lease.units, owed);
    lease.units -= paid;
    if (paid > 0) lease.lastSpentAt = now;
    owed -= paid;
    if (owed === 0) break;
  }
  lane.leases = lane.leases.filter((lease) => lease.units > 0);
  return true;
}

function noteLaneUnits(lane: Lane, units: number) {
  const now = Date.now();
  lane.recent.push({ at: now, units });
  if (lane.recent.length > 200) lane.recent.shift();
}

// What the lane kept admitting over the last lease, leaving out a burst that
// only just began: callers arriving together already share one round trip,
// and a burst can stop as suddenly as it started.
function recentLaneUnits(lane: Lane) {
  const now = Date.now();
  lane.recent = lane.recent.filter(
    (entry) => entry.at <= now && entry.at > now - LEASE_MS,
  );
  return lane.recent
    .filter((entry) => entry.at <= now - BURST_MS)
    .reduce((sum, entry) => sum + entry.units, 0);
}

// Only spending or a lower budget changes how soon the bucket has room, and
// both make it later, so the bucket's wait holds for up to
// `SHARED_BUCKET_WAIT_MS`; a wait set by the pace can end sooner, once others
// release what they reserved. A deferral comes from a marker another instance
// may clear at any time, so it is shared only briefly too.
function sharedWait(lane: Lane, waitKey: string, cost: number) {
  const wait = lane.waits.get(waitKey);
  if (!wait) return null;
  const now = Date.now();
  const shareMs =
    wait.held?.gate === "bucket" && !wait.defer
      ? SHARED_BUCKET_WAIT_MS
      : SHARED_WAIT_MS;
  if (
    wait.from > now ||
    now >= Math.min(wait.until, wait.from + shareMs) ||
    cost < wait.cost
  )
    return null;
  return { waitMs: wait.until - now, defer: wait.defer, held: wait.held };
}

function forgetLanes(
  emailAccountId: string,
  priorities: readonly GmailQuotaPriority[],
) {
  for (const priority of priorities) {
    const lane = lanes.get(`${emailAccountId}:${priority}`);
    if (!lane) continue;
    const now = Date.now();
    for (const lease of lane.leases) {
      gateStats.unspentLeaseUnits += lease.units;
      if (!lease.reservation || lease.units === 0 || lease.until <= now)
        continue;
      const releases = pendingReleases.get(emailAccountId) ?? [];
      // What was spent left at the latest when it was last spent from.
      releases.push({
        reservation: lease.reservation,
        kept: lease.total - lease.units,
        soonerMs: lease.until - (lease.lastSpentAt ?? lease.until),
        until: lease.until + PACE_WINDOW_MS,
      });
      pendingReleases.set(emailAccountId, releases);
      trimOldest(pendingReleases);
    }
    lane.leases = [];
    lane.waits.clear();
  }
}

function queueNote(
  emailAccountId: string,
  usageKey: string,
  field: string,
  amount: number,
) {
  let byKey = pendingNotes.get(emailAccountId);
  if (!byKey) {
    byKey = new Map();
    pendingNotes.set(emailAccountId, byKey);
  }
  let fields = byKey.get(usageKey);
  if (!fields) {
    fields = new Map();
    byKey.set(usageKey, fields);
  }
  if (!fields.has(field)) pendingNoteFields += 1;
  fields.set(field, (fields.get(field) ?? 0) + amount);
  pendingNotesSince ??= Date.now();
  if (pendingNotesDue()) flushNotes().catch(() => undefined);
}

/** Removes and returns the account's pending notes, or one usage key's. */
function takeNotes(
  emailAccountId: string,
  usageKey?: string,
): GmailQuotaNote[] {
  const byKey = pendingNotes.get(emailAccountId);
  if (!byKey) return [];
  const notes: GmailQuotaNote[] = [];
  for (const [key, fields] of byKey) {
    if (usageKey !== undefined && key !== usageKey) continue;
    for (const [field, amount] of fields)
      notes.push({ usageKey: key, field, amount });
    pendingNoteFields -= fields.size;
    byKey.delete(key);
  }
  if (byKey.size === 0) pendingNotes.delete(emailAccountId);
  if (pendingNotes.size === 0) pendingNotesSince = null;
  return notes;
}

function pendingNotesDue() {
  return (
    pendingNotesSince !== null &&
    (pendingNoteFields >= NOTE_FLUSH_FIELDS ||
      Date.now() - pendingNotesSince >= NOTE_FLUSH_MS)
  );
}

async function flushNotes() {
  const notes = [...pendingNotes.keys()].flatMap((emailAccountId) =>
    takeNotes(emailAccountId),
  );
  if (notes.length === 0) return;
  gateStats.noteFlushes += 1;
  gateStats.notesFlushed += notes.length;
  // Debug level in Axiom: one line per flush shows its size.
  logger.trace("Flushed Gmail quota notes", {
    notes: notes.length,
    usageKeys: new Set(notes.map((note) => note.usageKey)).size,
  });
  await withinStoreTimeout(gmailQuotaStore.note(notes)).catch(() => undefined);
}

// How many store round trips the gate made for how many Gmail calls, so the
// Redis commands it spends can be followed per instance, and what calls met
// at the in-flight cap.
function logGateSummary() {
  const now = Date.now();
  if (now - gateStatsSince < GATE_SUMMARY_INTERVAL_MS) return;
  const inflight = takeGmailInflightStats();
  if (gateStats.calls > 0 || gateStats.noteFlushes > 0)
    logger.info("Gmail quota gate", {
      intervalSeconds: Math.round((now - gateStatsSince) / 1000),
      ...gateStats,
      deferrals: [...deferralCounts].map(([key, count]) => {
        const [reason, deferredBy, priority, caller] = key.split("|");
        return { reason, deferredBy, priority, caller, count };
      }),
      inflightWaits: inflight.waits,
      inflightWaitMsTotal: inflight.waitMsTotal,
      inflightWaitMsMax: inflight.waitMsMax,
      inflightOverCap: inflight.overCap,
    });
  for (const key of Object.keys(gateStats) as (keyof typeof gateStats)[])
    gateStats[key] = 0;
  deferralCounts.clear();
  gateStatsSince = now;
}

async function withinStoreTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StoreTimeoutError()),
          STORE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class StoreTimeoutError extends Error {
  constructor() {
    super("Gmail quota store timed out");
  }
}

function isVolumeRefusal(error: unknown) {
  const { reason } = extractErrorInfo(error);
  return (
    (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") &&
    !isGmailNonVolumeRefusal(error)
  );
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
    pace: `${prefix}:pace`,
    interactiveDemand: `${prefix}:interactive-demand`,
    interactivePause: `${prefix}:interactive-pause`,
    syncPause: `${prefix}:sync-pause`,
    initialSync: `${prefix}:initial-sync`,
    backgroundPause: `${prefix}:background-pause`,
    backgroundSlow: `${prefix}:background-slow`,
    budget: `${prefix}:budget`,
    trailing: `${prefix}:trailing`,
    usage: (minute: number) => `${prefix}:usage:${minute}`,
  };
}
