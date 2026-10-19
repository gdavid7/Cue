import {
  type AxiomQueryResult,
  formatAxiomError,
  parseAxiomTabular,
  runAxiomQueries,
  summarizeAxiom,
} from "./health-report";
import {
  buildServiceHealthQueries,
  type ServiceHealthResults,
} from "./service-health";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Summarizes production's Axiom logs between `startTime` and `endTime`, or
 * says why it could not: NOT CONFIGURED without AXIOM_QUERY_TOKEN and
 * AXIOM_DATASET, an error when every query failed.
 */
export async function queryAxiomWindow({
  startTime,
  endTime,
}: {
  startTime: Date;
  endTime: Date;
}) {
  const token = process.env.AXIOM_QUERY_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) {
    return {
      status: "not_configured" as const,
      missing: ["AXIOM_QUERY_TOKEN", "AXIOM_DATASET"].filter(
        (name) => !process.env[name],
      ),
    };
  }
  const results = await runAxiomQueries(dataset, (apl) =>
    postAxiomQuery({ apl, token, startTime, endTime }),
  );
  const errors = Object.values(results).flatMap((result) =>
    "error" in result ? [result.error] : [],
  );
  if (errors.length === Object.keys(results).length) {
    return {
      status: "error" as const,
      error: `every Axiom query failed (${[...new Set(errors)].join("; ")})`,
    };
  }
  return { status: "ok" as const, summary: summarizeAxiom(results) };
}

/**
 * Runs the service-health queries, which carry their own `ago()` windows, over
 * the last day. Null without AXIOM_QUERY_TOKEN and AXIOM_DATASET.
 */
export async function queryServiceHealth(): Promise<ServiceHealthResults | null> {
  const token = process.env.AXIOM_QUERY_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) return null;
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 24 * 60 * 60_000);
  const queries = buildServiceHealthQueries(dataset);
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, apl]) => [
      name,
      await postAxiomQuery({ apl, token, startTime, endTime }),
    ]),
  );
  return Object.fromEntries(entries) as ServiceHealthResults;
}

async function postAxiomQuery({
  apl,
  token,
  startTime,
  endTime,
}: {
  apl: string;
  token: string;
  startTime: Date;
  endTime: Date;
}): Promise<AxiomQueryResult> {
  const baseUrl = process.env.AXIOM_URL || "https://api.axiom.co";
  try {
    const response = await fetch(`${baseUrl}/v1/datasets/_apl?format=tabular`, {
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
    });
    if (!response.ok) {
      return {
        error: formatAxiomError(
          response.status,
          await response.text().catch(() => ""),
        ),
      };
    }
    return { rows: parseAxiomTabular(await response.json()) };
  } catch (error) {
    return { error: errorName(error) };
  }
}

export function errorName(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return error instanceof Error ? error.name : "unknown error";
}
