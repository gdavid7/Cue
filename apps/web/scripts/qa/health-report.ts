import { z } from "zod";
import { sanitizeBrowserDiagnosticText } from "@/utils/playwright/browser-diagnostics";

export const HEALTH_REPORT_START = "=== CUE HEALTH REPORT START ===";
export const HEALTH_REPORT_END = "=== CUE HEALTH REPORT END ===";

const MAX_TEXT_LENGTH = 160;
const MAX_LIST_ITEMS = 10;
const MAX_AXIOM_ERROR_LENGTH = 200;
const MAX_STACK_FRAMES = 3;
const MAX_QUOTED_LENGTH = 24;
const QUOTED_TEXT = /"[^"\n]*"|'[^'\n]*'/g;
const STACK_ERROR_NAME = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?::|$)/;

const robotStepSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  metrics: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
  error: z.string().optional(),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(
    z.object({ method: z.string(), url: z.string(), status: z.number() }),
  ),
});

export const robotResultsSchema = z.object({
  status: z.enum([
    "passed",
    "failed",
    "needs_reconnect",
    "sign_in_failed",
    "not_configured",
  ]),
  baseUrl: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  note: z.string().optional(),
  steps: z.array(robotStepSchema),
});

export type RobotResults = z.infer<typeof robotResultsSchema>;
export type RobotStep = z.infer<typeof robotStepSchema>;

type SectionStatus<T> =
  | { status: "not_configured"; missing: string[] }
  | { status: "error"; error: string }
  | ({ status: "ok" } & T);

type AxiomRow = Record<string, unknown>;

export type AxiomQueryResult = { rows: AxiomRow[] } | { error: string };

export type AxiomResults = {
  totals: AxiomQueryResult;
  errorsByRoute: AxiomQueryResult;
  gmailRateLimited: AxiomQueryResult;
  gmailQuotaUsage: AxiomQueryResult;
  gmailDeferred: AxiomQueryResult;
  slowestRoutes: AxiomQueryResult;
  errorSamples: AxiomQueryResult;
};

export type SentryIssue = {
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  stats?: Record<string, [number, number][]>;
};

/**
 * One APL query per signal, so a failure only blanks that signal. Field names
 * follow next-axiom's event shape for `createScopedLogger`: top-level
 * `message` and `level`, and logger context flattened under `fields.*`
 * (`fields.url` is the request path). Axiom rejects a query with HTTP 400 when
 * it names a field missing from the dataset's schema, so every field goes
 * through `column_ifexists`; `appLogs` then shows whether app logs arrived.
 *
 * `errorSamples` keeps the latest event of each route and message pair. A
 * logged Error is serialized under `fields.error.*`; the middleware's
 * "Unhandled error" logs its message as `fields.error` and its stack as
 * `fields.stack`. next-axiom files its platform metadata under `vercel.*`
 * only on Vercel, so the sample also says whether the event came from there.
 */
export function buildAxiomQueries(dataset: string) {
  const source = `['${dataset.replaceAll("'", "")}'] | where _time > ago(1h)`;
  const level = `tostring(${field("level")})`;
  const message = `tostring(${field("message")})`;
  const route = `tostring(${field("fields.url")})`;
  const durationMs = `todouble(${field("fields.durationMs")})`;
  const totalUnits = `toint(${field("fields.totalUnits")})`;
  const limitUnits = `toint(${field("fields.limitUnits")})`;
  const text = (name: string) => `tostring(${field(name)})`;
  const sampleColumns = {
    errorName: text("fields.error.name"),
    errorMessage: text("fields.errorMessage"),
    errorStatus: text("fields.error.status"),
    errorCode: text("fields.error.code"),
    errorStack: `strcat(${text("fields.error.stack")}, ${text("fields.stack")})`,
    errorCause: text("fields.cause"),
    vercelEnvironment: text("vercel.environment"),
    vercelRegion: text("vercel.region"),
    gitRef: text("git.ref"),
  };
  const sampleNames = Object.keys(sampleColumns).join(", ");
  return {
    totals: `${source} | summarize total = count(), appLogs = countif(isnotempty(${level})), errors = countif(${level} == "error"), warnings = countif(${level} == "warn")`,
    errorsByRoute: `${source} | where ${level} == "error" | summarize events = count() by route = ${route}, message = ${message} | top ${MAX_LIST_ITEMS} by events`,
    gmailRateLimited: `${source} | search "rateLimitExceeded" | summarize events = count()`,
    gmailQuotaUsage: `${source} | where ${message} == "Gmail quota usage" | summarize samples = count(), maxUnits = max(${totalUnits}), avgUnits = avg(${totalUnits}), limitUnits = max(${limitUnits})`,
    gmailDeferred: `${source} | where ${message} == "Gmail call deferred by the account's quota budget" | summarize events = count()`,
    slowestRoutes: `${source} | where isnotnull(${durationMs}) | summarize p95Ms = percentile(${durationMs}, 95), maxMs = max(${durationMs}), events = count() by route = ${route} | top ${MAX_LIST_ITEMS} by p95Ms`,
    errorSamples: `${source} | where ${level} == "error" | extend route = ${route}, message = ${message}, ${Object.entries(
      sampleColumns,
    )
      .map(([name, expression]) => `${name} = ${expression}`)
      .join(
        ", ",
      )} | summarize arg_max(_time, ${sampleNames}) by route, message`,
  } satisfies Record<keyof AxiomResults, string>;
}

/** Keeps a failed query diagnosable: status plus the start of Axiom's reason. */
export function formatAxiomError(status: number, body: string) {
  const reason = sanitizeBrowserDiagnosticText(body)
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AXIOM_ERROR_LENGTH);
  return reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`;
}

/** Turns Axiom's `format=tabular` response into one object per row. */
export function parseAxiomTabular(body: unknown): AxiomRow[] {
  const table = (
    body as {
      tables?: { fields?: { name: string }[]; columns?: unknown[][] }[];
    }
  )?.tables?.[0];
  if (!table?.fields || !table.columns) return [];
  const fields = table.fields;
  const columns = table.columns;
  const rowCount = columns[0]?.length ?? 0;
  return Array.from({ length: rowCount }, (_, row) =>
    Object.fromEntries(
      fields.map((field, column) => [field.name, columns[column]?.[row]]),
    ),
  );
}

export function summarizeAxiom(results: AxiomResults) {
  const totals = firstRow(results.totals);
  const quota = firstRow(results.gmailQuotaUsage);
  const quotaSamples = toNumber(quota?.samples);
  const samples = new Map(
    rowsOf(results.errorSamples).map((row) => [errorKey(row), row]),
  );
  return {
    window: "1h",
    totalLogs: toNumber(totals?.total),
    appLogs: toNumber(totals?.appLogs),
    errors: toNumber(totals?.errors),
    warnings: toNumber(totals?.warnings),
    gmailRateLimitExceeded: toNumber(
      firstRow(results.gmailRateLimited)?.events,
    ),
    gmailQuota:
      "error" in results.gmailQuotaUsage
        ? { status: "query_failed" as const }
        : quotaSamples
          ? {
              status: "present" as const,
              samples: quotaSamples,
              maxUnitsPerMinute: toNumber(quota?.maxUnits),
              avgUnitsPerMinute: round(toNumber(quota?.avgUnits)),
              limitUnitsPerMinute: toNumber(quota?.limitUnits),
              deferredCalls: toNumber(firstRow(results.gmailDeferred)?.events),
            }
          : { status: "no_quota_logs" as const },
    topErrors: rowsOf(results.errorsByRoute).map((row) => {
      const sample = samples.get(errorKey(row));
      return {
        route: normalizeRoute(row.route),
        message: redact(row.message),
        count: toNumber(row.events),
        ...(sample ? { sample: summarizeErrorSample(sample) } : {}),
      };
    }),
    slowestRoutes: rowsOf(results.slowestRoutes).map((row) => ({
      route: normalizeRoute(row.route),
      p95Ms: Math.round(toNumber(row.p95Ms) ?? 0),
      maxMs: Math.round(toNumber(row.maxMs) ?? 0),
      count: toNumber(row.events),
    })),
    failedQueries: Object.entries(results)
      .filter(([, result]) => "error" in result)
      .map(([name, result]) => ({
        query: name,
        error: (result as { error: string }).error,
      })),
  };
}

export function summarizeSentry(issues: SentryIssue[], now = new Date()) {
  const dayAgo = now.getTime() - 86_400_000;
  const summarized = issues.map((issue) => {
    const firstSeen = issue.firstSeen
      ? Date.parse(issue.firstSeen)
      : Number.NaN;
    const events24h = issue.stats?.["24h"]
      ? issue.stats["24h"].reduce((sum, [, count]) => sum + count, 0)
      : toNumber(issue.count);
    return {
      id: issue.shortId ?? "unknown",
      title: redact(issue.title),
      culprit: normalizeRoute(issue.culprit),
      level: issue.level ?? "error",
      events24h: events24h ?? 0,
      users: issue.userCount ?? 0,
      isNew: firstSeen >= dayAgo,
      firstSeen: issue.firstSeen ?? null,
    };
  });
  summarized.sort((a, b) => b.events24h - a.events24h);
  return {
    window: "24h",
    unresolvedSeen: summarized.length,
    newIssues: summarized.filter((issue) => issue.isNew).length,
    topIssues: summarized.slice(0, MAX_LIST_ITEMS),
  };
}

export type HealthReport = ReturnType<typeof buildHealthReport>;

export function buildHealthReport({
  robot,
  axiom,
  sentry,
  now = new Date(),
}: {
  robot: SectionStatus<{ results: RobotResults }> | { status: "no_results" };
  axiom: SectionStatus<{ summary: ReturnType<typeof summarizeAxiom> }>;
  sentry: SectionStatus<{ summary: ReturnType<typeof summarizeSentry> }>;
  now?: Date;
}) {
  const robotSection = summarizeRobot(robot);
  const axiomSection =
    axiom.status === "ok" ? { status: "ok", ...axiom.summary } : axiom;
  const sentrySection =
    sentry.status === "ok" ? { status: "ok", ...sentry.summary } : sentry;
  return {
    version: 1,
    generatedAt: now.toISOString(),
    robot: robotSection,
    axiom: axiomSection,
    sentry: sentrySection,
    problems: listProblems({ robot: robotSection, axiom, sentry }),
  };
}

export function formatReportBlock(report: HealthReport) {
  return [HEALTH_REPORT_START, JSON.stringify(report), HEALTH_REPORT_END].join(
    "\n",
  );
}

export function formatHumanSummary(report: HealthReport) {
  const lines = [`Cue production health (${report.generatedAt})`];
  const robot = report.robot;
  if (robot.status === "not_configured") {
    lines.push(`Robot: NOT CONFIGURED (missing ${robot.missing.join(", ")})`);
  } else if (robot.status === "no_results") {
    lines.push("Robot: no results (the browser run crashed before reporting)");
  } else if (robot.status === "error") {
    lines.push(`Robot: results unreadable (${robot.error})`);
  } else {
    const passed = robot.steps.filter((step) => step.status === "passed");
    lines.push(
      `Robot: ${robot.outcome.toUpperCase()} (${passed.length}/${robot.steps.length} steps passed${
        robot.timeToFirstRowMs === undefined
          ? ""
          : `, first inbox row ${robot.timeToFirstRowMs} ms`
      })`,
    );
  }
  const axiom = report.axiom;
  if (axiom.status === "ok" && "errors" in axiom) {
    lines.push(
      `Axiom (1h): ${axiom.errors ?? "?"} errors, ${axiom.gmailRateLimitExceeded ?? "?"} Gmail rateLimitExceeded, quota logs: ${axiom.gmailQuota.status}`,
    );
  } else {
    lines.push(`Axiom: ${describeUnavailable(axiom)}`);
  }
  const sentry = report.sentry;
  if (sentry.status === "ok" && "newIssues" in sentry) {
    lines.push(
      `Sentry (24h): ${sentry.unresolvedSeen} unresolved issues seen, ${sentry.newIssues} new`,
    );
  } else {
    lines.push(`Sentry: ${describeUnavailable(sentry)}`);
  }
  lines.push(
    report.problems.length
      ? `Problems:\n${report.problems.map((problem) => `- ${problem}`).join("\n")}`
      : "Problems: none found",
  );
  return lines.join("\n");
}

export function formatJobSummary(report: HealthReport) {
  return [
    "## Cue production health",
    "",
    "```",
    formatHumanSummary(report),
    "```",
    "",
    "<details><summary>Machine-readable report</summary>",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Removes email addresses, credentials, and long identifiers from log text. */
export function redact(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = sanitizeBrowserDiagnosticText(String(value))
    .replaceAll(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ":uuid",
    )
    .replaceAll(/\b(?=[a-z0-9]*\d)[a-z0-9]{20,}\b/gi, ":id")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TEXT_LENGTH)}…`;
}

function normalizeRoute(value: unknown) {
  const route = redact(value).split(/[?#]/, 1)[0] ?? "";
  return route || "(no route)";
}

function summarizeRobot(
  robot: SectionStatus<{ results: RobotResults }> | { status: "no_results" },
) {
  if (robot.status !== "ok") return robot;
  const { results } = robot;
  const metric = (name: string) => {
    for (const step of results.steps) {
      const value = step.metrics?.[name];
      if (typeof value === "number") return Math.round(value);
    }
    return;
  };
  return {
    status: "ok" as const,
    outcome: results.status,
    note: results.note ? redact(results.note) : undefined,
    timeToFirstRowMs: metric("timeToFirstRowMs"),
    signOutMs: metric("signOutMs"),
    steps: results.steps.map((step) => ({
      name: step.name,
      status: step.status,
      durationMs: Math.round(step.durationMs),
      ...(step.metrics ? { metrics: step.metrics } : {}),
      ...(step.error ? { error: redact(step.error) } : {}),
      consoleErrors: step.consoleErrors.length,
      consoleErrorSamples: step.consoleErrors.slice(0, 3).map(redact),
      failedRequests: step.failedRequests
        .slice(0, MAX_LIST_ITEMS)
        .map(
          (request) =>
            `${request.status} ${request.method} ${normalizeRoute(request.url)}`,
        ),
    })),
  };
}

function listProblems({
  robot,
  axiom,
  sentry,
}: {
  robot: ReturnType<typeof summarizeRobot>;
  axiom: SectionStatus<{ summary: ReturnType<typeof summarizeAxiom> }>;
  sentry: SectionStatus<{ summary: ReturnType<typeof summarizeSentry> }>;
}) {
  const problems: string[] = [];
  if (robot.status === "no_results") {
    problems.push("Robot produced no results; see the Playwright step log.");
  } else if (robot.status === "error") {
    problems.push(`Robot results unreadable: ${robot.error}`);
  } else if (robot.status === "ok") {
    if (robot.outcome === "needs_reconnect") {
      problems.push(
        "TEST ACCOUNT NEEDS RECONNECTING: sign into Cue as the QA account with Google and reconnect Gmail (Testing-mode tokens expire every 7 days).",
      );
    } else if (robot.outcome === "sign_in_failed") {
      problems.push(
        `Robot could not sign in${robot.note ? `: ${robot.note}` : "."}`,
      );
    }
    for (const step of robot.steps) {
      if (step.status === "failed") {
        problems.push(
          `Robot step "${step.name}" failed${step.error ? `: ${step.error}` : ""}`,
        );
      }
    }
  }
  if (axiom.status === "ok") {
    const { summary } = axiom;
    if (summary.appLogs === 0) {
      problems.push(
        "Axiom has no app log events (no `level` field) in the last hour; server logs may not be reaching this dataset.",
      );
    }
    for (const failed of summary.failedQueries) {
      problems.push(`Axiom query ${failed.query} failed: ${failed.error}`);
    }
    if (summary.gmailRateLimitExceeded) {
      problems.push(
        `Gmail rateLimitExceeded logged ${summary.gmailRateLimitExceeded} times in the last hour.`,
      );
    }
    const top = summary.topErrors[0];
    if (top) {
      problems.push(
        `Most frequent error (1h): "${top.message}" on ${top.route} x${top.count ?? "?"}.`,
      );
    }
  } else if (axiom.status === "error") {
    problems.push(`Axiom query failed: ${axiom.error}`);
  }
  if (sentry.status === "ok") {
    for (const issue of sentry.summary.topIssues.filter((i) => i.isNew)) {
      problems.push(
        `New Sentry issue ${issue.id}: ${issue.title} (${issue.events24h} events, ${issue.users} users).`,
      );
    }
  } else if (sentry.status === "error") {
    problems.push(`Sentry query failed: ${sentry.error}`);
  }
  return problems;
}

function describeUnavailable(section: { status: string }) {
  if ("missing" in section) {
    return `NOT CONFIGURED (missing ${(section.missing as string[]).join(", ")})`;
  }
  if ("error" in section) return `query failed (${String(section.error)})`;
  return section.status;
}

function errorKey(row: AxiomRow) {
  return `${String(row.route ?? "")}\u0000${String(row.message ?? "")}`;
}

/**
 * One event behind a top error: what was thrown, where, and from which
 * deployment. Error text can echo user input, so it is redacted and quoted
 * values are dropped; stack frames only name code.
 */
function summarizeErrorSample(row: AxiomRow) {
  const [firstLine = "", ...lines] = String(row.errorStack ?? "").split("\n");
  const errorName =
    text(row.errorName) || firstLine.match(STACK_ERROR_NAME)?.[1];
  const status = [...new Set([text(row.errorStatus), text(row.errorCode)])]
    .filter(Boolean)
    .join(" ");
  const cause = redactErrorText(row.errorCause);
  return {
    errorName: errorName ? redact(errorName) : undefined,
    errorMessage: redactErrorText(row.errorMessage),
    ...(status ? { status: redact(status) } : {}),
    ...(cause ? { cause } : {}),
    stack: lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .slice(0, MAX_STACK_FRAMES)
      .map(redact),
    origin: describeOrigin(row),
  };
}

function redactErrorText(value: unknown) {
  return redact(
    text(value).replaceAll(QUOTED_TEXT, (quoted) =>
      quoted.length > MAX_QUOTED_LENGTH ? `${quoted[0]}…${quoted[0]}` : quoted,
    ),
  );
}

// Events logged outside Vercel (local builds, CI, scripts) share the dataset
// when they carry its token, so a sample says where it ran.
function describeOrigin(row: AxiomRow) {
  if (!text(row.vercelEnvironment)) return "not vercel";
  const region = text(row.vercelRegion);
  const ref = text(row.gitRef);
  return redact(
    ["vercel", region, ref ? `(${ref})` : ""].filter(Boolean).join(" "),
  );
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function firstRow(result: AxiomQueryResult) {
  return "rows" in result ? result.rows[0] : undefined;
}

function rowsOf(result: AxiomQueryResult) {
  return "rows" in result ? result.rows : [];
}

function toNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function round(value: number | undefined) {
  return value === undefined ? undefined : Math.round(value);
}

function field(name: string) {
  return `column_ifexists('${name}', "")`;
}
