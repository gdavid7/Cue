/**
 * Prints Cue's production health report: the browser robot's results, the
 * last hour of Axiom logs, and the last day of unresolved Sentry issues.
 *
 *   pnpm -F inbox-zero-ai exec tsx scripts/qa/run-health-report.ts [robot-results.json]
 *
 * Each source that is not configured is reported as NOT CONFIGURED instead of
 * failing. The script never prints secrets, mail content, or addresses.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  type AxiomQueryResult,
  type AxiomResults,
  buildAxiomQueries,
  buildHealthReport,
  formatHumanSummary,
  formatJobSummary,
  formatReportBlock,
  parseAxiomTabular,
  redact,
  robotResultsSchema,
  type SentryIssue,
  summarizeAxiom,
  summarizeSentry,
} from "./health-report";

const REQUEST_TIMEOUT_MS = 30_000;

main().catch((error: unknown) => {
  console.error(
    `::error title=Cue health report crashed::${redact(error instanceof Error ? error.message : error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  const resultsPath = process.argv[2];
  const report = buildHealthReport({
    robot: await readRobot(resultsPath),
    axiom: await queryAxiom(),
    sentry: await querySentry(),
  });

  console.log(formatReportBlock(report));
  console.log(formatHumanSummary(report));

  if (process.env.HEALTH_REPORT_FILE) {
    await writeFile(process.env.HEALTH_REPORT_FILE, JSON.stringify(report));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, formatJobSummary(report));
  }
  const outcome =
    report.robot.status === "ok" ? report.robot.outcome : report.robot.status;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `robot_outcome=${outcome}\n`);
  }
  if (outcome === "needs_reconnect") {
    console.log(
      "::warning title=Cue QA test account needs reconnecting::Sign into Cue as the QA account with Google and reconnect Gmail. The OAuth app is in Testing mode, so its refresh token expires every 7 days.",
    );
  }
}

async function readRobot(path: string | undefined) {
  if (!process.env.CUE_QA_EMAIL || !process.env.CUE_QA_IMAP_APP_PASSWORD) {
    return {
      status: "not_configured" as const,
      missing: missingEnv(["CUE_QA_EMAIL", "CUE_QA_IMAP_APP_PASSWORD"]),
    };
  }
  if (!path) return { status: "no_results" as const };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { status: "no_results" as const };
  }
  const parsed = robotResultsSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    return {
      status: "error" as const,
      error: "robot results did not match the expected shape",
    };
  }
  if (parsed.data.status === "not_configured") {
    return {
      status: "not_configured" as const,
      missing: ["robot reported its own configuration as incomplete"],
    };
  }
  return { status: "ok" as const, results: parsed.data };
}

async function queryAxiom() {
  const token = process.env.AXIOM_QUERY_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) {
    return {
      status: "not_configured" as const,
      missing: missingEnv(["AXIOM_QUERY_TOKEN", "AXIOM_DATASET"]),
    };
  }
  const baseUrl = process.env.AXIOM_URL || "https://api.axiom.co";
  const queries = buildAxiomQueries(dataset);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 60 * 60_000);
  const entries = await Promise.all(
    Object.entries(queries).map(
      async ([name, apl]): Promise<[string, AxiomQueryResult]> => {
        try {
          const response = await fetch(
            `${baseUrl}/v1/datasets/_apl?format=tabular`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                apl,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            },
          );
          if (!response.ok) {
            return [name, { error: `HTTP ${response.status}` }];
          }
          return [name, { rows: parseAxiomTabular(await response.json()) }];
        } catch (error) {
          return [name, { error: errorName(error) }];
        }
      },
    ),
  );
  const results = Object.fromEntries(entries) as AxiomResults;
  if (Object.values(results).every((result) => "error" in result)) {
    const first = Object.values(results)[0] as { error: string };
    return {
      status: "error" as const,
      error: `every Axiom query failed (${first.error})`,
    };
  }
  return { status: "ok" as const, summary: summarizeAxiom(results) };
}

async function querySentry() {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const organization = process.env.SENTRY_ORGANIZATION;
  const project = process.env.SENTRY_PROJECT;
  if (!token || !organization || !project) {
    return {
      status: "not_configured" as const,
      missing: missingEnv([
        "SENTRY_AUTH_TOKEN",
        "SENTRY_ORGANIZATION",
        "SENTRY_PROJECT",
      ]),
    };
  }
  const baseUrl = process.env.SENTRY_URL || "https://sentry.io";
  const params = new URLSearchParams({
    query: "is:unresolved lastSeen:-24h",
    statsPeriod: "24h",
    sort: "freq",
    limit: "50",
  });
  try {
    const response = await fetch(
      `${baseUrl}/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/issues/?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return { status: "error" as const, error: `HTTP ${response.status}` };
    }
    const issues = (await response.json()) as SentryIssue[];
    return { status: "ok" as const, summary: summarizeSentry(issues) };
  } catch (error) {
    return { status: "error" as const, error: errorName(error) };
  }
}

function missingEnv(names: string[]) {
  return names.filter((name) => !process.env[name]);
}

function errorName(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return error instanceof Error ? error.name : "unknown error";
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
