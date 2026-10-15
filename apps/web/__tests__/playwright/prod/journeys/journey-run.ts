import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConsoleMessage,
  Page,
  Response,
  TestInfo,
} from "@playwright/test";
import {
  type Budgets,
  evaluateAttempt,
  type JourneyAttempt,
  type JourneyName,
  type JourneyRecord,
  type JourneyResults,
} from "@/scripts/qa/journey-report";
import { sanitizeBrowserDiagnosticText } from "@/utils/playwright/browser-diagnostics";
import { describeError } from "../robot-run";

const MAX_DIAGNOSTICS = 20;

export type AttemptContext = {
  attempt: number;
  metrics: JourneyAttempt["metrics"];
  check: (name: string, ok: boolean, detail?: string) => void;
  /** Milliseconds left before the run's deadline. */
  remainingMs: () => number;
};

/**
 * Runs each selected journey, records its numbers, checks and browser
 * diagnostics, and retries a journey once when its first attempt FAILS by the
 * same rules the report uses. A retry only starts when the run's deadline
 * leaves room for it, and a journey that would not fit is skipped and said so.
 */
export class JourneyRun {
  readonly journeys: JourneyRecord[] = [];
  outcome: JourneyResults["outcome"] = "completed";
  note: string | undefined;
  cleanup: JourneyResults["cleanup"] = { removed: 0 };
  private current: JourneyAttempt | null = null;
  private readonly startedAt = new Date();
  private readonly options: {
    mode: JourneyResults["mode"];
    baseUrl: string;
    runTag: string;
    resultsFile: string;
    selected: JourneyName[];
    budgets: Budgets;
    deadline: number;
  };

  constructor(options: JourneyRun["options"]) {
    this.options = options;
  }

  attach(page: Page) {
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error") return;
      push(this.current?.diagnostics.consoleErrors, () =>
        sanitizeBrowserDiagnosticText(message.text()),
      );
    });
    page.on("pageerror", (error) => {
      push(this.current?.diagnostics.pageErrors, () =>
        sanitizeBrowserDiagnosticText(error.message),
      );
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400) return;
      push(this.current?.diagnostics.failedRequests, () => ({
        method: response.request().method(),
        url: sanitizeUrl(response.url()),
        status: response.status(),
      }));
    });
  }

  remainingMs() {
    return this.options.deadline - Date.now();
  }

  async run(
    name: JourneyName,
    {
      page,
      testInfo,
      estimateMs,
    }: { page: Page; testInfo: TestInfo; estimateMs: number },
    body: (context: AttemptContext) => Promise<void>,
  ) {
    if (!this.options.selected.includes(name)) return;
    const record: JourneyRecord = { name, attempts: [] };
    this.journeys.push(record);
    try {
      await this.attempts(record, page, testInfo, estimateMs, body);
    } finally {
      // Written as it goes, so a run cut short still reports what it saw.
      await this.write();
    }
  }

  private async attempts(
    record: JourneyRecord,
    page: Page,
    testInfo: TestInfo,
    estimateMs: number,
    body: (context: AttemptContext) => Promise<void>,
  ) {
    const name = record.name;
    const blocked = this.blockedReason();
    if (blocked) {
      record.skipped = blocked;
      return;
    }
    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
      if (this.remainingMs() < estimateMs) {
        if (attemptNumber === 1) {
          record.skipped = `not started: under ${Math.round(estimateMs / 1000)}s left in the run`;
        }
        return;
      }
      const attempt: JourneyAttempt = {
        ok: true,
        durationMs: 0,
        metrics: {},
        checks: [],
        diagnostics: { consoleErrors: [], pageErrors: [], failedRequests: [] },
      };
      this.current = attempt;
      const started = performance.now();
      try {
        await body({
          attempt: attemptNumber,
          metrics: attempt.metrics,
          check: (checkName, ok, detail) =>
            attempt.checks.push({
              name: checkName,
              ok,
              ...(detail ? { detail } : {}),
            }),
          remainingMs: () => this.remainingMs(),
        });
      } catch (error) {
        attempt.ok = false;
        attempt.error = describeError(error);
      } finally {
        attempt.durationMs = Math.round(performance.now() - started);
        this.current = null;
        await page
          .screenshot({
            path: testInfo.outputPath(`${name}-attempt-${attemptNumber}.png`),
          })
          .catch(() => undefined);
      }
      record.attempts.push(attempt);
      const { verdict } = evaluateAttempt(
        attempt,
        this.options.budgets,
        this.options.baseUrl,
      );
      if (verdict !== "FAIL" || this.blockedReason()) return;
    }
  }

  get failedJourneys() {
    return this.journeys
      .filter((journey) => {
        const last = journey.attempts.at(-1);
        return (
          last &&
          evaluateAttempt(last, this.options.budgets, this.options.baseUrl)
            .verdict === "FAIL"
        );
      })
      .map((journey) => journey.name);
  }

  async write() {
    const results: JourneyResults = {
      version: 1,
      mode: this.options.mode,
      baseUrl: this.options.baseUrl,
      runTag: this.options.runTag,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: this.outcome,
      ...(this.note ? { note: this.note } : {}),
      selected: this.options.selected,
      journeys: this.journeys,
      cleanup: this.cleanup,
    };
    await mkdir(path.dirname(this.options.resultsFile), { recursive: true });
    await writeFile(this.options.resultsFile, JSON.stringify(results, null, 2));
  }

  private blockedReason() {
    if (this.outcome === "sign_in_failed" || this.outcome === "not_configured")
      return "no session";
    if (this.outcome === "needs_reconnect")
      return "the QA account's Gmail connection needs reconnecting";
    return null;
  }
}

function push<T>(list: T[] | undefined, make: () => T) {
  if (!list || list.length >= MAX_DIAGNOSTICS) return;
  list.push(make());
}

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}
