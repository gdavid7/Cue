import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type TestInfo,
} from "@playwright/test";

export type PerfProfile = "laptop" | "phone";

/**
 * Regression budgets for the flows people repeat all day, set at roughly two
 * to three times what the seeded mailbox measures on a shared CI runner, so a
 * regression that matters fails and a noisy runner does not. Medians are
 * asserted, not maxima. The Gmail-level targets themselves are tighter; the
 * perf harness in `perf/` reports against those.
 */
export const PERF_BUDGETS_MS = {
  // A cold load includes the account's first sync.
  coldInboxRows: 20_000,
  warmInboxRows: 8000,
  openCachedEmail: 600,
  archive: 500,
  star: 300,
  markRead: 400,
  switchView: 1000,
  search: 1000,
  compose: 1000,
} as const;

export const perfProfile: PerfProfile =
  process.env.PERF_PROFILE === "phone" ? "phone" : "laptop";
export const perfRuns = Number(process.env.PERF_RUNS ?? 3);

export type PerfSample = { flow: string; ms: number; detail?: unknown };

export class PerfRecorder {
  samples: PerfSample[] = [];

  add(flow: string, ms: number, detail?: unknown) {
    this.samples.push({ flow, ms: Math.round(ms), detail });
  }

  summary() {
    const flows = new Map<string, number[]>();
    for (const sample of this.samples) {
      flows.set(sample.flow, [...(flows.get(sample.flow) ?? []), sample.ms]);
    }
    return Object.fromEntries(
      [...flows].map(([flow, values]) => [flow, summarize(values)]),
    );
  }

  median(flow: string) {
    const values = this.samples.filter((s) => s.flow === flow).map((s) => s.ms);
    return values.length ? summarize(values).median : Number.NaN;
  }

  async attach(testInfo: TestInfo, name: string) {
    const body = JSON.stringify(
      { profile: perfProfile, summary: this.summary(), samples: this.samples },
      null,
      2,
    );
    console.log(`PERF ${name} ${JSON.stringify(this.summary())}`);
    await testInfo.attach(`${name}.json`, {
      body,
      contentType: "application/json",
    });
    const reportFile = process.env.PERF_REPORT_FILE;
    if (reportFile)
      writeFileSync(`${reportFile}.${perfProfile}.${name}.json`, body);
  }
}

/**
 * A signed-in context with the profile's device emulation. It runs on a
 * persistent profile, as people's browsers do: an incognito context keeps the
 * local mailbox in memory behind a browser round trip per disk access, which
 * makes every local write many times slower than it really is.
 */
export async function newPerfContext(browser: Browser) {
  if (process.env.PERF_INCOGNITO === "1") {
    const context = await browser.newContext({
      storageState: process.env.PLAYWRIGHT_AUTH_FILE,
      ...deviceOptions(),
    });
    await context.addInitScript(installVitalsObservers);
    return context;
  }
  const profiles = path.resolve(".tmp", "playwright", "perf-profiles");
  mkdirSync(profiles, { recursive: true });
  const userDataDir = mkdtempSync(path.join(profiles, "profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    baseURL: process.env.NEXT_PUBLIC_BASE_URL,
    ...deviceOptions(),
  });
  context.on("close", () => {
    // Chrome can still be flushing its cache as the context closes.
    try {
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {
      // A leftover profile only costs disk under .tmp.
    }
  });
  const authFile = process.env.PLAYWRIGHT_AUTH_FILE;
  if (!authFile) throw new Error("PLAYWRIGHT_AUTH_FILE is not configured");
  const { cookies } = JSON.parse(readFileSync(authFile, "utf8")) as {
    cookies: Parameters<BrowserContext["addCookies"]>[0];
  };
  await context.addCookies(cookies);
  await context.addInitScript(installVitalsObservers);
  return context;
}

export async function newPerfPage(
  context: BrowserContext,
  { network = false }: { network?: boolean } = {},
) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (perfProfile === "phone") {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  if (network) {
    await cdp.send("Network.enable");
    // Chrome DevTools' "Fast 4G" preset.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 60,
      downloadThroughput: (9 * 1024 * 1024) / 8,
      uploadThroughput: (1.5 * 1024 * 1024) / 8,
    });
  }
  return page;
}

/** Arms the next keydown or pointerdown as the start of a measured interaction. */
export async function armInteraction(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __perfT0?: number };
    state.__perfT0 = undefined;
    const arm = (event: Event) => {
      state.__perfT0 ??= event.timeStamp;
    };
    window.addEventListener("keydown", arm, { capture: true, once: true });
    window.addEventListener("pointerdown", arm, { capture: true, once: true });
  });
}

/**
 * Milliseconds from the armed input event until `predicate` first holds on an
 * animation frame. The predicate returns `performance.now()` once satisfied.
 * The wait is long so one slow sample is recorded rather than ending the run;
 * budgets judge medians.
 */
export async function timeSinceInput<A>(
  page: Page,
  predicate: (arg: A) => number | false,
  arg: A,
  timeout = 45_000,
) {
  const handle = await page.waitForFunction(asPageFunction(predicate), arg, {
    polling: "raf",
    timeout,
  });
  const end = (await handle.jsonValue()) as number;
  const start = await page.evaluate(
    () => (window as unknown as { __perfT0?: number }).__perfT0,
  );
  if (start === undefined) throw new Error("No input reached the page");
  return end - start;
}

/** Milliseconds from navigation start until `predicate` first holds. */
export async function timeSinceNavigation<A>(
  page: Page,
  predicate: (arg: A) => number | false,
  arg: A,
  timeout = 60_000,
) {
  const handle = await page.waitForFunction(asPageFunction(predicate), arg, {
    polling: "raf",
    timeout,
  });
  return (await handle.jsonValue()) as number;
}

/**
 * Lets the first sync settle so later timings measure the UI rather than the
 * backfill. A mailbox still syncing after the wait is measured as it is.
 */
export async function waitForEngineIdle(page: Page) {
  const deadline = Date.now() + Number(process.env.PERF_SYNC_WAIT_MS ?? 10_000);
  while (Date.now() < deadline) {
    const idle = await page.evaluate(async () => {
      const diagnostics = (await window.__inboxZeroMailInspect
        ?.read()
        .catch(() => null)) as {
        coverage?: { lastCompletedSyncAtMs?: number | null }[];
      } | null;
      return Boolean(
        diagnostics?.coverage?.some((c) => c.lastCompletedSyncAtMs),
      );
    });
    if (idle) break;
    await page.waitForTimeout(500);
  }
  if (perfProfile === "phone") await page.waitForTimeout(500);
}

export function firstInboxRowVisible() {
  const row = document.querySelector(
    '[role="listbox"][aria-label="Conversations"] [data-mail-thread-row]',
  );
  return row && row.getBoundingClientRect().height > 0
    ? performance.now()
    : false;
}

export function rowWithSubjectGone(subject: string) {
  for (const element of document.querySelectorAll("[data-mail-thread-subject]"))
    if (element.textContent === subject) return false;
  return performance.now();
}

export function rowWithSubjectMatches({
  subject,
  text,
  present,
}: {
  subject: string;
  text: string;
  present: boolean;
}) {
  for (const element of document.querySelectorAll(
    "[data-mail-thread-subject]",
  )) {
    if (element.textContent !== subject) continue;
    const row = element.closest("[data-mail-thread-row]");
    if (!row) continue;
    return (row.textContent ?? "").includes(text) === present
      ? performance.now()
      : false;
  }
  return false;
}

export function readerShowsText(text: string) {
  const reader = document.querySelector('[data-testid="thread-reader"]');
  if (!reader) return false;
  if ((reader.textContent ?? "").includes(text)) return performance.now();
  for (const frame of reader.querySelectorAll("iframe")) {
    const body = frame.contentDocument?.body;
    if (body && (body.textContent ?? "").includes(text))
      return performance.now();
  }
  return false;
}

export function firstRowSubject() {
  return (
    document.querySelector(
      '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
    )?.textContent ?? ""
  );
}

export function editorReady() {
  const editor = document.querySelector<HTMLElement>(
    '[role="dialog"] [contenteditable="true"]',
  );
  return editor && editor.getBoundingClientRect().height > 0
    ? performance.now()
    : false;
}

export function headingMatches(source: string) {
  const pattern = new RegExp(source);
  for (const heading of document.querySelectorAll("h1, h2, [role=heading]"))
    if (pattern.test(heading.textContent ?? "")) return performance.now();
  return false;
}

export function pageShowsText(text: string) {
  return document.body.innerText.includes(text) ? performance.now() : false;
}

export async function readVitals(page: Page) {
  return page.evaluate(() => {
    const vitals = (window as unknown as { __perfVitals: PerfVitals })
      .__perfVitals;
    const navigation = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    const interactions = [...vitals.interactions].sort((a, b) => b - a);
    return {
      ttfb: Math.round(navigation?.responseStart ?? 0),
      fcp: Math.round(
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
          0,
      ),
      lcp: Math.round(vitals.lcp),
      cls: Number(vitals.cls.toFixed(3)),
      longTaskMs: Math.round(vitals.longTaskMs),
      longestTaskMs: Math.round(vitals.longestTaskMs),
      // INP is the worst interaction, ignoring one outlier per 50.
      inp: interactions[Math.floor(interactions.length / 50)] ?? 0,
      interactions: interactions.length,
    };
  });
}

/**
 * The mail engine's startup marks from the page and its worker, in
 * milliseconds since the page's navigation started, so a slow first list can
 * be broken down into the phase that held it up.
 */
export async function readEngineTimeline(page: Page) {
  const read = () => ({
    timeOrigin: performance.timeOrigin,
    marks: performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("mail-engine:"))
      .map((entry) => ({ name: entry.name, at: entry.startTime })),
    // The engine's own requests, such as its first sync, by path.
    fetches: (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    )
      .filter((entry) => entry.initiatorType === "fetch")
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        start: entry.startTime,
        end: entry.responseEnd,
      })),
    isWorker: typeof document === "undefined",
  });
  const pageTimeline = await page.evaluate(read);
  const workerTimelines = await Promise.all(
    page.workers().map((worker) => worker.evaluate(read).catch(() => null)),
  );
  const phases: Record<string, number> = {};
  for (const timeline of [pageTimeline, ...workerTimelines]) {
    if (!timeline) continue;
    const offset = timeline.timeOrigin - pageTimeline.timeOrigin;
    for (const { name, at } of timeline.marks) {
      // A page can start more than one worker; the first mark wins.
      const key = name.slice("mail-engine:".length);
      phases[key] = Math.min(
        phases[key] ?? Number.POSITIVE_INFINITY,
        at + offset,
      );
    }
    if (!timeline.isWorker) continue;
    for (const { path: requestPath, start, end } of timeline.fetches) {
      const key = `fetch${requestPath.replace(/\/[^/]*\d[^/]*/g, "/:id")}`;
      if (phases[`${key}:start`] !== undefined) continue;
      phases[`${key}:start`] = start + offset;
      phases[`${key}:end`] = end + offset;
    }
  }
  return phases;
}

type PerfVitals = {
  lcp: number;
  cls: number;
  longTaskMs: number;
  longestTaskMs: number;
  interactions: number[];
};

function installVitalsObservers() {
  const vitals: PerfVitals = {
    lcp: 0,
    cls: 0,
    longTaskMs: 0,
    longestTaskMs: 0,
    interactions: [],
  };
  (window as unknown as { __perfVitals: PerfVitals }).__perfVitals = vitals;
  const observe = (
    type: string,
    onEntry: (entry: PerformanceEntry) => void,
    extra?: Record<string, unknown>,
  ) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry);
      }).observe({ type, buffered: true, ...extra });
    } catch {
      // Unsupported entry type.
    }
  };
  observe("largest-contentful-paint", (entry) => {
    vitals.lcp = entry.startTime;
  });
  observe("layout-shift", (entry) => {
    const shift = entry as PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
    };
    if (!shift.hadRecentInput) vitals.cls += shift.value;
  });
  observe("longtask", (entry) => {
    vitals.longTaskMs += entry.duration;
    vitals.longestTaskMs = Math.max(vitals.longestTaskMs, entry.duration);
  });
  const byInteraction = new Map<number, number>();
  observe(
    "event",
    (entry) => {
      const event = entry as PerformanceEntry & { interactionId?: number };
      if (!event.interactionId) return;
      const previous = byInteraction.get(event.interactionId) ?? 0;
      if (entry.duration <= previous) return;
      byInteraction.set(event.interactionId, entry.duration);
      vitals.interactions = [...byInteraction.values()];
    },
    { durationThreshold: 16 },
  );
}

// Playwright types a page function's argument after serialization; these
// predicates only take plain JSON values, so the two types agree.
function asPageFunction<A>(predicate: (arg: A) => number | false) {
  return predicate as (arg: unknown) => number | false;
}

function deviceOptions() {
  return perfProfile === "phone"
    ? {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      }
    : { viewport: { width: 1440, height: 900 } };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
  return {
    n: sorted.length,
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    p95: pick(95),
    max: sorted[sorted.length - 1],
  };
}
