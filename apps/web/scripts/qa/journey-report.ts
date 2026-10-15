import { z } from "zod";
import { redact } from "./health-report";

// The journeys robot's results format, the budgets each journey is judged
// against, and the report it prints. The browser run records raw numbers and
// checks; this module alone decides PASS, SLOW or FAIL, so the spec (which
// retries a failed attempt once) and the report always agree.

export const JOURNEYS_REPORT_START = "=== CUE JOURNEYS REPORT START ===";
export const JOURNEYS_REPORT_END = "=== CUE JOURNEYS REPORT END ===";
export const JOURNEYS_METRICS_START = "=== CUE JOURNEYS METRICS START ===";
export const JOURNEYS_METRICS_END = "=== CUE JOURNEYS METRICS END ===";

export const JOURNEY_NAMES = [
  "inbox-load",
  "new-mail",
  "triage",
  "search",
  "compose-send",
  "chat",
] as const;
export type JourneyName = (typeof JOURNEY_NAMES)[number];

const MAX_PROBLEMS = 12;
const MAX_SAMPLES = 3;

const attemptSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number(),
  metrics: z.record(z.string(), z.union([z.number(), z.boolean()])),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  diagnostics: z.object({
    consoleErrors: z.array(z.string()),
    pageErrors: z.array(z.string()),
    failedRequests: z.array(
      z.object({ method: z.string(), url: z.string(), status: z.number() }),
    ),
  }),
});

const journeySchema = z.object({
  name: z.enum(JOURNEY_NAMES),
  attempts: z.array(attemptSchema),
  /** Why the journey did not run, when it did not. */
  skipped: z.string().optional(),
});

export const journeyResultsSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["production", "emulated"]),
  baseUrl: z.string(),
  runTag: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  outcome: z.enum([
    "completed",
    "sign_in_failed",
    "needs_reconnect",
    "not_configured",
  ]),
  note: z.string().optional(),
  selected: z.array(z.enum(JOURNEY_NAMES)),
  journeys: z.array(journeySchema),
  cleanup: z.object({ removed: z.number(), error: z.string().optional() }),
});

export type JourneyResults = z.infer<typeof journeyResultsSchema>;
export type JourneyAttempt = z.infer<typeof attemptSchema>;
export type JourneyRecord = z.infer<typeof journeySchema>;

/**
 * Over `target` a journey is SLOW; over `limit` it FAILS. Metric names may
 * carry a `:detail` suffix (a chat question's id, a delivery method), which
 * shares its base metric's budget.
 */
export type Budget = { target: number; limit: number };
export type Budgets = Record<string, Budget>;

export const DEFAULT_BUDGETS: Budgets = {
  // The first inbox row after sign-in, on a fresh browser.
  firstRowMs: { target: 5000, limit: 30_000 },
  // A message delivered while the inbox is open, until its row shows.
  newMailWhileOpenMs: { target: 10_000, limit: 60_000 },
  // A message delivered while the app was closed, from opening the inbox.
  newMailOnOpenMs: { target: 3000, limit: 15_000 },
  openEmailMs: { target: 1500, limit: 10_000 },
  archiveMs: { target: 1000, limit: 5000 },
  undoMs: { target: 1500, limit: 8000 },
  searchMs: { target: 3000, limit: 15_000 },
  composeOpenMs: { target: 1000, limit: 5000 },
  // From Send until the message to itself is back in the mailbox; includes
  // the 30-second undo-send window.
  sendToInboxMs: { target: 45_000, limit: 120_000 },
  chatFirstTokenMs: { target: 8000, limit: 45_000 },
  chatTotalMs: { target: 40_000, limit: 150_000 },
  // Cumulative layout shift during the journey, times 1000.
  clsX1000: { target: 100, limit: 250 },
};

/** Merges a JSON override such as `{"newMailWhileOpenMs":{"target":5000}}`. */
export function resolveBudgets(override: string | undefined): Budgets {
  if (!override?.trim()) return DEFAULT_BUDGETS;
  const parsed = z
    .record(
      z.string(),
      z.object({ target: z.number().optional(), limit: z.number().optional() }),
    )
    .safeParse(safeJson(override));
  if (!parsed.success)
    throw new Error("Journey budget override is not valid JSON budgets");
  const budgets: Budgets = { ...DEFAULT_BUDGETS };
  for (const [name, value] of Object.entries(parsed.data)) {
    const base = budgets[name] ?? {
      target: Number.POSITIVE_INFINITY,
      limit: Number.POSITIVE_INFINITY,
    };
    budgets[name] = {
      target: value.target ?? base.target,
      limit: value.limit ?? base.limit,
    };
  }
  return budgets;
}

/** Which journeys to run from a `journeys` input: a comma list or "all". */
export function parseJourneySelection(
  input: string | undefined,
): JourneyName[] {
  const value = input?.trim().toLowerCase() ?? "";
  if (!value || value === "all") return [...JOURNEY_NAMES];
  const requested = value.split(/[\s,]+/).filter(Boolean);
  const unknown = requested.filter(
    (name) => !(JOURNEY_NAMES as readonly string[]).includes(name),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown journeys: ${unknown.join(", ")}. Choose from ${JOURNEY_NAMES.join(", ")} or "all".`,
    );
  }
  return JOURNEY_NAMES.filter((name) => requested.includes(name));
}

export type Verdict = "PASS" | "SLOW" | "FAIL";
type Finding = { severity: "fail" | "slow" | "warn"; message: string };

/**
 * Judges one attempt. It FAILS when the run threw, a check failed, a metric
 * passed its limit, the page threw or hydration broke, or our own server
 * answered 5xx. It is SLOW when a metric passed its target. Other console
 * errors and 4xx responses are reported as warnings.
 */
export function evaluateAttempt(
  attempt: JourneyAttempt,
  budgets: Budgets,
  baseUrl: string,
) {
  const findings: Finding[] = [];
  if (!attempt.ok) {
    findings.push({ severity: "fail", message: attempt.error ?? "failed" });
  }
  for (const check of attempt.checks) {
    if (!check.ok) {
      findings.push({
        severity: "fail",
        message: `${check.name}${check.detail ? `: ${check.detail}` : ""}`,
      });
    }
  }
  for (const [name, value] of Object.entries(attempt.metrics)) {
    if (typeof value !== "number") continue;
    const budget = budgets[name.split(":")[0]];
    if (!budget) continue;
    if (value > budget.limit) {
      findings.push({
        severity: "fail",
        message: `${name} ${Math.round(value)} over limit ${budget.limit}`,
      });
    } else if (value > budget.target) {
      findings.push({
        severity: "slow",
        message: `${name} ${Math.round(value)} over target ${budget.target}`,
      });
    }
  }
  const origin = safeOrigin(baseUrl);
  const ours = attempt.diagnostics.failedRequests.filter(
    (request) => safeOrigin(request.url) === origin,
  );
  const serverErrors = ours.filter((request) => request.status >= 500);
  if (serverErrors.length) {
    findings.push({
      severity: "fail",
      message: `server errors: ${describeRequests(serverErrors)}`,
    });
  }
  const clientErrors = ours.filter((request) => request.status < 500);
  if (clientErrors.length) {
    findings.push({
      severity: "warn",
      message: `4xx responses: ${describeRequests(clientErrors)}`,
    });
  }
  const hydration = attempt.diagnostics.consoleErrors.filter(isHydrationError);
  if (attempt.diagnostics.pageErrors.length || hydration.length) {
    findings.push({
      severity: "fail",
      message: `uncaught page errors: ${[
        ...attempt.diagnostics.pageErrors,
        ...hydration,
      ]
        .slice(0, MAX_SAMPLES)
        .map(redact)
        .join(" | ")}`,
    });
  }
  const otherConsole = attempt.diagnostics.consoleErrors.filter(
    (message) => !isHydrationError(message),
  );
  if (otherConsole.length) {
    findings.push({
      severity: "warn",
      message: `${otherConsole.length} console errors, e.g. ${redact(otherConsole[0])}`,
    });
  }
  const verdict: Verdict = findings.some((f) => f.severity === "fail")
    ? "FAIL"
    : findings.some((f) => f.severity === "slow")
      ? "SLOW"
      : "PASS";
  return { verdict, findings };
}

export type JourneysReport = ReturnType<typeof buildJourneysReport>;

export type AxiomRunSummary = {
  status: string;
  errors?: number;
  warnings?: number;
  gmailRateLimitExceeded?: number;
  topErrors?: { route: string; message: string; count?: number }[];
  error?: string;
  missing?: string[];
};

export function buildJourneysReport({
  results,
  budgets,
  axiom,
  now = new Date(),
}: {
  results:
    | { status: "ok"; data: JourneyResults }
    | { status: "missing" | "unreadable" };
  budgets: Budgets;
  axiom: AxiomRunSummary;
  now?: Date;
}) {
  if (results.status !== "ok") {
    return {
      version: 1 as const,
      generatedAt: now.toISOString(),
      outcome:
        results.status === "missing" ? "no_results" : "unreadable_results",
      overall: "FAIL" as Verdict,
      journeys: [],
      flaky: [],
      axiom,
      problems: [
        results.status === "missing"
          ? "The journeys run wrote no results; see the Playwright step log."
          : "The journeys results did not match the expected shape.",
      ],
    };
  }
  const data = results.data;
  const journeys = data.journeys.map((journey) => {
    const evaluated = journey.attempts.map((attempt) =>
      evaluateAttempt(attempt, budgets, data.baseUrl),
    );
    const final = evaluated.at(-1);
    const last = journey.attempts.at(-1);
    return {
      name: journey.name,
      status: journey.skipped
        ? ("SKIPPED" as const)
        : (final?.verdict ?? "FAIL"),
      ...(journey.skipped ? { skipped: redact(journey.skipped) } : {}),
      attempts: journey.attempts.length,
      flaky:
        journey.attempts.length > 1 &&
        evaluated[0]?.verdict === "FAIL" &&
        final?.verdict !== "FAIL",
      durationMs: last ? Math.round(last.durationMs) : 0,
      metrics: last ? roundMetrics(last.metrics) : {},
      budgets: last ? budgetsFor(last.metrics, budgets) : {},
      checks:
        last?.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          ...(check.detail ? { detail: redact(check.detail) } : {}),
        })) ?? [],
      findings: (final?.findings ?? []).map((finding) => ({
        ...finding,
        message: redact(finding.message),
      })),
      ...(journey.attempts.length > 1
        ? {
            firstAttempt: {
              verdict: evaluated[0]?.verdict,
              findings: (evaluated[0]?.findings ?? [])
                .filter((f) => f.severity === "fail")
                .slice(0, MAX_SAMPLES)
                .map((f) => redact(f.message)),
            },
          }
        : {}),
    };
  });
  const ran = journeys.filter((journey) => journey.status !== "SKIPPED");
  const blocked =
    data.outcome === "sign_in_failed" || data.outcome === "not_configured";
  const overall: Verdict =
    blocked || ran.some((journey) => journey.status === "FAIL")
      ? "FAIL"
      : ran.some((journey) => journey.status === "SLOW")
        ? "SLOW"
        : "PASS";
  return {
    version: 1 as const,
    generatedAt: now.toISOString(),
    mode: data.mode,
    baseUrl: data.baseUrl,
    runTag: data.runTag,
    window: { startedAt: data.startedAt, finishedAt: data.finishedAt },
    outcome: data.outcome,
    ...(data.note ? { note: redact(data.note) } : {}),
    overall,
    journeys,
    flaky: journeys.filter((journey) => journey.flaky).map((j) => j.name),
    cleanup: data.cleanup,
    axiom,
    problems: listProblems({ data, journeys, axiom }),
  };
}

export function formatJourneysReport(report: JourneysReport) {
  const lines = [
    `Cue journeys: ${report.overall} (${report.generatedAt}${"mode" in report ? `, ${report.mode}` : ""})`,
  ];
  for (const journey of report.journeys) {
    const numbers = Object.entries(journey.metrics)
      .filter(([, value]) => typeof value === "number")
      .map(([name, value]) => {
        const budget = journey.budgets[name];
        return budget
          ? `${name}=${value}/${budget.target}`
          : `${name}=${value}`;
      });
    const flags = [
      journey.flaky ? "FLAKY" : "",
      journey.attempts > 1 ? `${journey.attempts} attempts` : "",
    ].filter(Boolean);
    lines.push(
      `- ${journey.name}: ${journey.status}${flags.length ? ` (${flags.join(", ")})` : ""}${
        journey.status === "SKIPPED" && "skipped" in journey
          ? ` – ${journey.skipped}`
          : ""
      }${numbers.length ? ` | ${numbers.join(" ")}` : ""}`,
    );
  }
  if (report.flaky.length)
    lines.push(`Flaky (passed on retry): ${report.flaky.join(", ")}`);
  lines.push(`Server logs during the run: ${describeAxiom(report.axiom)}`);
  lines.push(
    report.problems.length
      ? `Top problems:\n${report.problems.map((problem) => `  * ${problem}`).join("\n")}`
      : "Top problems: none",
  );
  return [JOURNEYS_REPORT_START, ...lines, JOURNEYS_REPORT_END].join("\n");
}

export function formatJourneysMetricsBlock(report: JourneysReport) {
  return [
    JOURNEYS_METRICS_START,
    JSON.stringify(report),
    JOURNEYS_METRICS_END,
  ].join("\n");
}

export function formatJourneysJobSummary(report: JourneysReport) {
  return [
    "## Cue journeys",
    "",
    "```",
    formatJourneysReport(report),
    "```",
    "",
    "<details><summary>Machine-readable metrics</summary>",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

function listProblems({
  data,
  journeys,
  axiom,
}: {
  data: JourneyResults;
  journeys: {
    name: string;
    status: string;
    findings: Finding[];
    flaky: boolean;
    firstAttempt?: { findings: string[] };
  }[];
  axiom: AxiomRunSummary;
}) {
  const problems: string[] = [];
  if (data.outcome === "sign_in_failed") {
    problems.push(
      `Could not sign in${data.note ? `: ${redact(data.note)}` : "."}`,
    );
  } else if (data.outcome === "needs_reconnect") {
    problems.push(
      "TEST ACCOUNT NEEDS RECONNECTING: sign into Cue as the QA account with Google and reconnect Gmail.",
    );
  } else if (data.outcome === "not_configured") {
    problems.push("QA account secrets are not configured; nothing ran.");
  }
  const rank = { fail: 0, slow: 1, warn: 2 } as const;
  const findings = journeys
    .flatMap((journey) =>
      journey.findings.map((finding) => ({
        journey: journey.name,
        ...finding,
      })),
    )
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  for (const finding of findings) {
    problems.push(
      `${finding.severity.toUpperCase()} ${finding.journey}: ${finding.message}`,
    );
  }
  for (const journey of journeys.filter((j) => j.flaky)) {
    problems.push(
      `FLAKY ${journey.name}: failed first (${journey.firstAttempt?.findings.join("; ") || "unknown"}), passed on retry`,
    );
  }
  if (data.cleanup.error)
    problems.push(`Cleanup failed: ${redact(data.cleanup.error)}`);
  if (axiom.status === "ok" && axiom.errors) {
    const top = axiom.topErrors?.[0];
    problems.push(
      `Server logged ${axiom.errors} errors during the run${top ? `, most often "${top.message}" on ${top.route}` : ""}.`,
    );
  }
  if (axiom.status === "ok" && axiom.gmailRateLimitExceeded) {
    problems.push(
      `Gmail rateLimitExceeded logged ${axiom.gmailRateLimitExceeded} times during the run.`,
    );
  }
  return problems.slice(0, MAX_PROBLEMS);
}

function describeAxiom(axiom: AxiomRunSummary) {
  if (axiom.status === "ok") {
    return `${axiom.errors ?? "?"} errors, ${axiom.warnings ?? "?"} warnings, ${axiom.gmailRateLimitExceeded ?? "?"} Gmail rateLimitExceeded`;
  }
  if (axiom.status === "not_queried")
    return "not queried (not a production run)";
  if (axiom.status === "not_configured") {
    return `NOT CONFIGURED (missing ${axiom.missing?.join(", ") ?? "Axiom secrets"})`;
  }
  return `query failed (${axiom.error ?? axiom.status})`;
}

/** React's production hydration errors are minified to these codes. */
function isHydrationError(message: string) {
  return /hydrat|Minified React error #(418|423|425)\b/i.test(message);
}

function describeRequests(
  requests: { method: string; url: string; status: number }[],
) {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const key = `${request.status} ${request.method} ${pathOf(request.url)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .slice(0, MAX_SAMPLES)
    .map(([key, count]) => (count > 1 ? `${key} x${count}` : key))
    .join(", ");
}

function budgetsFor(metrics: JourneyAttempt["metrics"], budgets: Budgets) {
  const entries = Object.keys(metrics).flatMap((name) => {
    const budget = budgets[name.split(":")[0]];
    return budget ? [[name, budget] as const] : [];
  });
  return Object.fromEntries(entries);
}

function roundMetrics(metrics: JourneyAttempt["metrics"]) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => [
      name,
      typeof value === "number" ? Math.round(value) : value,
    ]),
  );
}

function pathOf(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
