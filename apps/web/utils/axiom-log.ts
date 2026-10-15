/** biome-ignore-all lint/suspicious/noConsole: reports about log delivery cannot go through the logger they describe */
import { config, isVercelIntegration, Logger } from "next-axiom";
import { env } from "@/env";

const MAX_REASON_LENGTH = 200;
const reported = new Set<string>();

/**
 * next-axiom's logger, reporting on the console what became of each batch.
 * next-axiom sends with `fetch(...).catch(console.error)` and never reads the
 * response, so a wrong token, a misnamed dataset or events Axiom refuses (such
 * as past the dataset's field limit) would otherwise leave no trace at all.
 * Each outcome is reported once per server instance.
 */
class CheckedAxiomLogger extends Logger {
  override async sendLogs() {
    const count = this.logEvents.length;
    if (count > 0 && !config.isEnvVarsSet()) {
      reportOnce(
        "not-configured",
        "warn",
        "Axiom log shipping is on but next-axiom has no dataset and token (or ingest endpoint) at runtime, so it prints logs instead of sending them",
      );
    }
    const response: unknown = await super.sendLogs();
    if (count > 0 && response instanceof Response) {
      await reportIngestResponse(response, count);
    }
    return response;
  }
}

export const axiomLog = new CheckedAxiomLogger();

/**
 * Where server logs go, without secrets: the dataset name and host, and which
 * variable each came from. next-axiom prefers the NEXT_PUBLIC_ variables, and
 * the Vercel integration's ingest endpoint over both.
 */
export function describeAxiomTarget() {
  const host = getHost(config.getLogsEndpoint());
  if (isVercelIntegration) {
    return `the Axiom Vercel integration's ingest endpoint at ${host}, which picks the dataset itself`;
  }
  const datasetSource = env.NEXT_PUBLIC_AXIOM_DATASET
    ? "NEXT_PUBLIC_AXIOM_DATASET"
    : "AXIOM_DATASET";
  const tokenSource = env.NEXT_PUBLIC_AXIOM_TOKEN
    ? "NEXT_PUBLIC_AXIOM_TOKEN"
    : "AXIOM_TOKEN";
  return `dataset "${config.dataset ?? ""}" (from ${datasetSource}) at ${host}, token from ${tokenSource}`;
}

async function reportIngestResponse(response: Response, count: number) {
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    reportOnce(
      `http-${response.status}`,
      "warn",
      `Axiom refused ${count} log events with HTTP ${response.status} (${describeAxiomTarget()}): ${reason(body)}`,
    );
    return;
  }
  const result = parseIngestResult(body);
  if (result.failed) {
    const firstError = result.failures?.[0]?.error ?? "";
    reportOnce(
      `failed-${firstError.slice(0, 80)}`,
      "warn",
      `Axiom accepted the request but dropped ${result.failed} of ${count} log events (${describeAxiomTarget()}): ${reason(firstError)}`,
    );
    return;
  }
  reportOnce(
    "delivered",
    "info",
    `Axiom log shipping works: HTTP ${response.status}, ${count} events to ${describeAxiomTarget()}`,
  );
}

function reportOnce(key: string, level: "info" | "warn", message: string) {
  if (reported.has(key)) return;
  reported.add(key);
  if (level === "warn") console.warn(`[axiom]: ${message}`);
  else console.log(`[axiom]: ${message}`);
}

function parseIngestResult(body: string): {
  failed?: number;
  failures?: { error?: string }[];
} {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function reason(text: string) {
  const trimmed = text.replaceAll(/\s+/g, " ").trim();
  return trimmed.length > MAX_REASON_LENGTH
    ? `${trimmed.slice(0, MAX_REASON_LENGTH)}…`
    : trimmed || "(no reason given)";
}

function getHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "(no endpoint)";
  }
}
