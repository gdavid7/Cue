/**
 * Prints the journeys robot's report: each journey PASS, SLOW or FAIL against
 * its budgets, flaky journeys, and the server errors Axiom logged during the
 * run. The human report sits between `=== CUE JOURNEYS REPORT START/END ===`
 * and the full metrics JSON between `=== CUE JOURNEYS METRICS START/END ===`.
 *
 *   pnpm -F inbox-zero-ai exec tsx scripts/qa/run-journeys-report.ts [results.json]
 *
 * Writes the metrics JSON to JOURNEYS_REPORT_FILE when set, and `overall` and
 * `outcome` to GITHUB_OUTPUT. Never prints secrets, mail content or addresses.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { queryAxiomWindow } from "./axiom-query";
import { redact } from "./health-report";
import {
  type AxiomRunSummary,
  buildJourneysReport,
  formatJourneysJobSummary,
  formatJourneysMetricsBlock,
  formatJourneysReport,
  journeyResultsSchema,
  resolveBudgets,
} from "./journey-report";

// Axiom ingests within seconds, but a request still running at the end of
// the run logs a little later.
const AXIOM_TRAILING_MS = 60_000;

main().catch((error: unknown) => {
  console.error(
    `::error title=Cue journeys report crashed::${redact(error instanceof Error ? error.message : error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  const results = await readResults(process.argv[2]);
  const report = buildJourneysReport({
    results,
    budgets: resolveBudgets(process.env.CUE_JOURNEY_BUDGETS),
    axiom:
      results.status === "ok" && results.data.mode === "production"
        ? await queryRunWindow(results.data.startedAt, results.data.finishedAt)
        : { status: "not_queried" },
  });

  console.log(formatJourneysReport(report));
  console.log(formatJourneysMetricsBlock(report));

  if (process.env.JOURNEYS_REPORT_FILE) {
    await writeFile(
      process.env.JOURNEYS_REPORT_FILE,
      JSON.stringify(report, null, 2),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      formatJourneysJobSummary(report),
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `overall=${report.overall}\noutcome=${report.outcome}\n`,
    );
  }
}

async function readResults(path: string | undefined) {
  if (!path) return { status: "missing" as const };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { status: "missing" as const };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Reported as unreadable below.
  }
  const parsed = journeyResultsSchema.safeParse(json);
  return parsed.success
    ? { status: "ok" as const, data: parsed.data }
    : { status: "unreadable" as const };
}

async function queryRunWindow(
  startedAt: string,
  finishedAt: string,
): Promise<AxiomRunSummary> {
  const result = await queryAxiomWindow({
    startTime: new Date(startedAt),
    endTime: new Date(
      Math.min(Date.now(), Date.parse(finishedAt) + AXIOM_TRAILING_MS),
    ),
  });
  if (result.status !== "ok") return result;
  const { summary } = result;
  return {
    status: "ok",
    errors: summary.errors,
    warnings: summary.warnings,
    gmailRateLimitExceeded: summary.gmailRateLimitExceeded,
    topErrors: summary.topErrors.slice(0, 5).map((error) => ({
      route: error.route,
      message: error.message,
      count: error.count,
    })),
  };
}
