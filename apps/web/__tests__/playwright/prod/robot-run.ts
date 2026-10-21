import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  ConsoleMessage,
  Page,
  Response,
  TestInfo,
} from "@playwright/test";
import type { RobotResults, RobotStep } from "@/scripts/qa/health-report";
import { sanitizeBrowserDiagnosticText } from "@/utils/playwright/browser-diagnostics";

const MAX_DIAGNOSTICS_PER_STEP = 20;

type StepRequirement = "session" | "gmail" | "outlook";

/**
 * Records each robot step's outcome, timing, console errors and HTTP errors.
 * Steps keep going after a failure so one broken page does not hide the rest,
 * except that nothing runs without a session, Gmail-backed steps skip when
 * the QA account's Gmail connection has lapsed, and Outlook steps skip once
 * the Outlook QA mailbox turned out to be missing from Cue.
 */
export class RobotRun {
  readonly steps: RobotStep[] = [];
  status: RobotResults["status"] = "passed";
  note: string | undefined;
  private outlookBlocked: string | null = null;
  private current: RobotStep | null = null;
  private readonly startedAt = new Date();
  private attached = false;
  private readonly baseUrl: string;
  private readonly resultsFile: string;

  constructor(baseUrl: string, resultsFile: string) {
    this.baseUrl = baseUrl;
    this.resultsFile = resultsFile;
  }

  attach(page: Page) {
    if (this.attached) return;
    this.attached = true;
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error" || !this.current) return;
      if (this.current.consoleErrors.length >= MAX_DIAGNOSTICS_PER_STEP) return;
      this.current.consoleErrors.push(
        sanitizeBrowserDiagnosticText(message.text()),
      );
    });
    page.on("pageerror", (error) => {
      if (!this.current) return;
      if (this.current.consoleErrors.length >= MAX_DIAGNOSTICS_PER_STEP) return;
      this.current.consoleErrors.push(
        `Uncaught: ${sanitizeBrowserDiagnosticText(error.message)}`,
      );
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400 || !this.current) return;
      if (this.current.failedRequests.length >= MAX_DIAGNOSTICS_PER_STEP)
        return;
      this.current.failedRequests.push({
        method: response.request().method(),
        url: sanitizeUrl(response.url()),
        status: response.status(),
      });
    });
  }

  async step(
    name: string,
    {
      page,
      testInfo,
      requires = "session",
      describePageOnFailure = false,
    }: {
      page: Page;
      testInfo: TestInfo;
      requires?: StepRequirement;
      // Only for pages without mail content: a thread's heading is its subject,
      // and the report is public.
      describePageOnFailure?: boolean;
    },
    run: (metrics: RobotStep["metrics"] & object) => Promise<void>,
  ) {
    const step: RobotStep = {
      name,
      status: "passed",
      durationMs: 0,
      consoleErrors: [],
      failedRequests: [],
    };
    this.steps.push(step);
    const blocked = this.blockedReason(requires);
    if (blocked) {
      step.status = "skipped";
      step.error = blocked;
      return;
    }
    const metrics: Record<string, number | boolean> = {};
    this.current = step;
    const started = performance.now();
    try {
      await run(metrics);
    } catch (error) {
      if (error instanceof StepSkippedError) {
        step.status = "skipped";
        step.error = error.message;
        return;
      }
      step.status = "failed";
      step.error = describeError(error);
      if (describePageOnFailure)
        step.error += ` (on ${await describePage(page)})`;
      if (this.status === "passed") this.status = "failed";
    } finally {
      step.durationMs = Math.round(performance.now() - started);
      if (Object.keys(metrics).length) step.metrics = metrics;
      this.current = null;
      await page
        .screenshot({
          path: testInfo.outputPath(
            `${String(this.steps.length).padStart(2, "0")}-${slug(name)}.png`,
          ),
          fullPage: false,
        })
        .catch(() => undefined);
    }
  }

  signInFailed(note: string) {
    this.status = "sign_in_failed";
    this.note = note;
  }

  /** Later Outlook steps skip, saying why; the failed step reports it. */
  outlookUnavailable(reason: string) {
    this.outlookBlocked = reason;
  }

  needsReconnect(note: string) {
    this.status = "needs_reconnect";
    this.note = note;
  }

  get failedSteps() {
    return this.steps.filter((step) => step.status === "failed");
  }

  async write(status?: RobotResults["status"]) {
    const results: RobotResults = {
      status: status ?? this.status,
      baseUrl: this.baseUrl,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(this.note ? { note: this.note } : {}),
      steps: this.steps,
    };
    await mkdir(path.dirname(this.resultsFile), { recursive: true });
    await writeFile(this.resultsFile, JSON.stringify(results, null, 2));
  }

  private blockedReason(requires: StepRequirement) {
    if (this.status === "sign_in_failed" || this.status === "not_configured")
      return "Skipped: the robot has no session.";
    if (requires === "gmail" && this.status === "needs_reconnect")
      return "Skipped: the QA account's Gmail connection needs reconnecting.";
    if (requires === "outlook" && this.outlookBlocked)
      return `Skipped: ${this.outlookBlocked}`;
    return null;
  }
}

/** Thrown by a step that could not run its check; it is reported, not failed. */
export class StepSkippedError extends Error {}

/** First line of a Playwright error, without mail content or addresses. */
export function describeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright appends call logs and locator dumps after the first line, and
  // colors the text with ANSI escapes.
  const firstLine = stripVTControlCharacters(message).split("\n")[0];
  return sanitizeBrowserDiagnosticText(firstLine || "Unknown error");
}

/** The path and main heading, so a failed step says what was on screen. */
async function describePage(page: Page) {
  const path = new URL(page.url()).pathname;
  const heading = await page
    .getByRole("heading", { level: 1 })
    .first()
    .innerText({ timeout: 2000 })
    .catch(() => null);
  const text = heading?.replaceAll(/\s+/g, " ").trim().slice(0, 80);
  return sanitizeBrowserDiagnosticText(
    text ? `${path}, heading "${text}"` : `${path}, no main heading`,
  );
}

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
