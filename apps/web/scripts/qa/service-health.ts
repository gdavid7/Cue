import type { AxiomQueryResult } from "./health-report";

// Thresholds for the failures a returning user actually hits. Changing one
// changes what the hourly robot calls a failure.
export const SLOW_LOAD_SCOPES = ["mail/v1/enumeration", "mail/v1/changes"];
export const SLOW_LOAD_P95_MS = 10_000;
// A rate needs a minimum of logged requests, or one call on a quiet hour is a p95.
export const MIN_REQUESTS_FOR_RATE = 5;
// A second counts as pinned at this share of the cap the "Gmail quota usage"
// line reports as `peakSecondCapUnits` (the highest PACE_CAP in
// utils/gmail/quota.ts). Lines without that field are not judged.
export const GMAIL_PINNED_CAP_SHARE = 0.95;
export const GMAIL_PINNED_MINUTES = 3;
export const AI_SCOPES = [
  "user/suggested-reply",
  "user/thread-context",
  "user/thread-brief",
  "user/inbox-insights",
];
export const AI_503_RATE_LIMIT = 0.1;
export const DEFERRED_PER_MINUTE_LIMIT = 50;

const SHORT_WINDOW = "1h";
const DRAFTING_WINDOW = "24h";
const MINUTE_MS = 60_000;
const P95_SLOW_SHARE = 0.05;

export type ServiceCheckStatus = "PASS" | "WARN" | "FAIL";

export type ServiceCheck = {
  name: string;
  status: ServiceCheckStatus;
  lines: string[];
};

export type ServiceHealthResults = {
  requestLatency: AxiomQueryResult;
  quotaPeaks: AxiomQueryResult;
  aiRequests: AxiomQueryResult;
  deferredStorms: AxiomQueryResult;
  drafting: AxiomQueryResult;
};

// The robot holds no Vercel credential and this check must not add one.
export const DEPLOY_CHECK_SKIPPED: ServiceCheck = {
  name: "Deploy health",
  status: "WARN",
  lines: [
    "skipped: the robot has no Vercel credential; add a read-only one to check that the latest production deployment is READY",
  ],
};

/**
 * Aggregate-only queries. Fast successful requests are logged for a sample, so
 * counts are weighted by 1/sampleRate. Every request over a second is logged
 * unsampled, which makes the share over 10s exact, and a p95 above 10s is the
 * same as more than 5% of requests over 10s.
 */
export function buildServiceHealthQueries(dataset: string) {
  const source = (window: string) =>
    `['${dataset.replaceAll("'", "")}'] | where _time > ago(${window})`;
  const field = (name: string) => `['fields']['${name}']`;
  const weight = `iff(isnotnull(${field("sampleRate")}) and todouble(${field("sampleRate")}) > 0, 1.0 / todouble(${field("sampleRate")}), 1.0)`;
  const requests = (scopes: string[]) =>
    `${source(SHORT_WINDOW)} | where ['message'] == "Request completed" | extend scope = tostring(${field("scope")}), weight = ${weight} | where scope in (${scopes.map((scope) => `'${scope}'`).join(", ")})`;
  return {
    requestLatency: `${requests(SLOW_LOAD_SCOPES)} | summarize requests = sum(weight), slowRequests = sumif(weight, todouble(${field("durationMs")}) > ${SLOW_LOAD_P95_MS}), events = count() by scope`,
    quotaPeaks: `${source(SHORT_WINDOW)} | where ['message'] == "Gmail quota usage" | where isnotnull(${field("peakSecondCapUnits")}) | summarize peakSecondUnits = max(toint(${field("peakSecondUnits")})), capUnits = max(toint(${field("peakSecondCapUnits")})) by account = tostring(${field("emailAccountId")}), minute = bin(_time, 1m) | where peakSecondUnits >= ${GMAIL_PINNED_CAP_SHARE} * capUnits | order by account asc, minute asc`,
    aiRequests: `${requests(AI_SCOPES)} | summarize requests = sum(weight), unavailable = sumif(weight, toint(${field("status")}) == 503), events = count() by scope`,
    deferredStorms: `${source(SHORT_WINDOW)} | where ['message'] == "Gmail call deferred by the account's quota budget" | summarize deferred = count() by account = tostring(${field("emailAccountId")}), minute = bin(_time, 1m) | where deferred > ${DEFERRED_PER_MINUTE_LIMIT} | summarize minutes = count(), peakPerMinute = max(deferred) by account`,
    drafting: `${source(DRAFTING_WINDOW)} | summarize toReply = countif(['message'] == "AI determined thread status" and tostring(${field("scope")}) == "conversation-status-handler" and tostring(${field("status")}) == "TO_REPLY"), draftActions = countif(['message'] == "Running action" and tostring(${field("actionType")}) == "DRAFT_EMAIL"), suggested = countif(['message'] == "Reply suggestion outcome" and tostring(${field("outcome")}) == "suggested"), outcomeLogs = countif(['message'] == "Reply suggestion outcome")`,
  } satisfies Record<keyof ServiceHealthResults, string>;
}

export function evaluateServiceHealth(
  results: ServiceHealthResults,
): ServiceCheck[] {
  return [
    checkSlowLoad(results.requestLatency),
    checkQuotaPinned(results.quotaPeaks),
    checkAiUnavailable(results.aiRequests),
    checkRetryStorm(results.deferredStorms),
    checkDrafting(results.drafting),
  ];
}

export function worstStatus(checks: ServiceCheck[]): ServiceCheckStatus {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  return checks.some((check) => check.status === "WARN") ? "WARN" : "PASS";
}

export function formatServiceHealthMarkdown(checks: ServiceCheck[]) {
  return [
    "## Service health",
    "",
    ...checks.flatMap((check) => [
      `### ${check.status}: ${check.name}`,
      ...check.lines.map((line) => `- ${line}`),
      "",
    ]),
  ].join("\n");
}

function checkSlowLoad(result: AxiomQueryResult): ServiceCheck {
  const name = `Slow returning load (p95 over ${SLOW_LOAD_P95_MS / 1000}s, ${SHORT_WINDOW})`;
  if ("error" in result) return queryFailed(name, result.error);
  const lines: string[] = [];
  let failed = false;
  for (const scope of SLOW_LOAD_SCOPES) {
    const row = result.rows.find((r) => r.scope === scope);
    const events = toNumber(row?.events);
    if (!row || events < MIN_REQUESTS_FOR_RATE) {
      lines.push(`${scope}: ${events} logged requests, too few to judge`);
      continue;
    }
    const requests = toNumber(row.requests);
    const share = toNumber(row.slowRequests) / requests;
    const exceeds = share > P95_SLOW_SHARE;
    failed ||= exceeds;
    lines.push(
      `${scope}: ${(share * 100).toFixed(1)}% of ~${Math.round(requests)} requests over ${SLOW_LOAD_P95_MS / 1000}s, p95 ${exceeds ? "above" : "within"} the limit`,
    );
  }
  return { name, status: failed ? "FAIL" : "PASS", lines };
}

function checkQuotaPinned(result: AxiomQueryResult): ServiceCheck {
  const name = `Gmail per-second cap pinned (${GMAIL_PINNED_MINUTES}+ consecutive minutes, ${SHORT_WINDOW})`;
  if ("error" in result) return queryFailed(name, result.error);
  const minutesByAccount = new Map<string, number[]>();
  let capUnits = 0;
  for (const row of result.rows) {
    capUnits = Math.max(capUnits, toNumber(row.capUnits));
    const minute = Date.parse(String(row.minute));
    if (Number.isNaN(minute)) continue;
    const account = String(row.account);
    minutesByAccount.set(account, [
      ...(minutesByAccount.get(account) ?? []),
      minute,
    ]);
  }
  const lines: string[] = [];
  let failed = false;
  for (const [account, minutes] of minutesByAccount) {
    const longest = longestRun(minutes);
    const pinned = longest >= GMAIL_PINNED_MINUTES;
    failed ||= pinned;
    lines.push(
      `account ${shortId(account)}: ${new Set(minutes).size} minutes near the ${capUnits} units/s cap, longest run ${longest}${pinned ? " (pinned)" : ""}`,
    );
  }
  if (!lines.length) {
    lines.push("no account pinned at the per-second cap");
  }
  return { name, status: failed ? "FAIL" : "PASS", lines };
}

function checkAiUnavailable(result: AxiomQueryResult): ServiceCheck {
  const name = `Stuck AI on open threads (503 rate over ${AI_503_RATE_LIMIT * 100}%, ${SHORT_WINDOW})`;
  if ("error" in result) return queryFailed(name, result.error);
  const lines: string[] = [];
  let failed = false;
  for (const scope of AI_SCOPES) {
    const row = result.rows.find((r) => r.scope === scope);
    const events = toNumber(row?.events);
    if (!row || events < MIN_REQUESTS_FOR_RATE) {
      lines.push(`${scope}: ${events} logged requests, too few to judge`);
      continue;
    }
    const requests = toNumber(row.requests);
    const rate = toNumber(row.unavailable) / requests;
    const exceeds = rate > AI_503_RATE_LIMIT;
    failed ||= exceeds;
    lines.push(
      `${scope}: ${(rate * 100).toFixed(1)}% 503 of ~${Math.round(requests)} requests${exceeds ? " (over limit)" : ""}`,
    );
  }
  return { name, status: failed ? "FAIL" : "PASS", lines };
}

function checkRetryStorm(result: AxiomQueryResult): ServiceCheck {
  const name = `Gmail retry storm (over ${DEFERRED_PER_MINUTE_LIMIT} deferred calls per minute, ${SHORT_WINDOW})`;
  if ("error" in result) return queryFailed(name, result.error);
  if (!result.rows.length) {
    return {
      name,
      status: "PASS",
      lines: [
        `no account had more than ${DEFERRED_PER_MINUTE_LIMIT} deferred calls in a minute`,
      ],
    };
  }
  return {
    name,
    status: "FAIL",
    lines: result.rows.map(
      (row) =>
        `account ${shortId(String(row.account))}: ${toNumber(row.minutes)} minutes over the limit, peak ${toNumber(row.peakPerMinute)} deferred calls/min`,
    ),
  };
}

function checkDrafting(result: AxiomQueryResult): ServiceCheck {
  const name = `Drafting dead (${DRAFTING_WINDOW})`;
  if ("error" in result) return queryFailed(name, result.error);
  const row = result.rows[0];
  const toReply = toNumber(row?.toReply);
  const drafts = toNumber(row?.draftActions);
  const suggested = toNumber(row?.suggested);
  const outcomeLogs = toNumber(row?.outcomeLogs);
  const lines = [
    `inbound To Reply classifications: ${toReply}`,
    `DRAFT_EMAIL executions: ${drafts}`,
    outcomeLogs
      ? `reply suggestions with outcome=suggested: ${suggested} of ${outcomeLogs} outcome logs`
      : '"Reply suggestion outcome" log line absent (not shipped yet); judged on DRAFT_EMAIL executions alone',
  ];
  if (toReply === 0 || suggested > 0 || drafts > 0) {
    return { name, status: "PASS", lines };
  }
  // Without the outcome line, zero drafts cannot tell dead from not yet shipped.
  return { name, status: outcomeLogs ? "FAIL" : "WARN", lines };
}

function queryFailed(name: string, error: string): ServiceCheck {
  return { name, status: "WARN", lines: [`query failed (${error})`] };
}

function longestRun(minutes: number[]) {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b);
  let longest = 0;
  let current = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const minute of sorted) {
    current = minute - previous === MINUTE_MS ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = minute;
  }
  return longest;
}

// Public logs show only the tail of an account id.
function shortId(id: string) {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

function toNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
