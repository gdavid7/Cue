import { expect, type Page, type Request } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { buildMailPath } from "@/utils/mail-url";
import {
  PerfRecorder,
  armInteraction,
  firstInboxRowVisible,
  newPerfContext,
  newPerfPage,
  perfRuns,
  waitForEngineIdle,
} from "./perf-test-helpers";

// Today and the inbox are two views of one mail app, so moving between them
// should feel like switching mailboxes: the sidebar answers the click at once
// and the destination shows what it last showed while it refreshes. Budgets
// are medians of the repeat switches: the highlight is the 100 ms response
// target, the rest about twice what a loaded runner measures. The first switch
// to Today waits on Gmail for its lanes, so it is reported but not judged.
const SWITCH_BUDGETS_MS = {
  highlight: 100,
  todayShown: 300,
  todayContent: 300,
  inboxShown: 400,
  inboxContent: 400,
} as const;

const inbox = buildMailPath({ accountIndex: 0 });
// A deployed server answers navigations and Today's data far slower than a
// local one, so each such request waits this long first. Without it a switch
// that waits on the server would still pass against a local one.
const serverLatencyMs = Number(process.env.PERF_SERVER_LATENCY_MS ?? 400);

type Destination = "today" | "inbox";
type SwitchTimes = {
  highlight?: number;
  url?: number;
  shown?: number;
  content?: number;
};

test("switching between Today and the inbox answers at once", async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const recorder = new PerfRecorder();
  const context = await newPerfContext(browser);
  await context.addInitScript(countWorkers);
  if (serverLatencyMs > 0) {
    await context.route(
      (url) =>
        url.searchParams.has("_rsc") || url.pathname === "/api/user/home",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, serverLatencyMs));
        await route.fallback();
      },
    );
  }
  const page = await newPerfPage(context);
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  try {
    await page.goto(inbox);
    await page.waitForFunction(firstInboxRowVisible, undefined, {
      timeout: 60_000,
    });
    await waitForEngineIdle(page);

    const switchTo = async (destination: Destination, phase: string) => {
      await page.evaluate(tagMounted);
      const before = await page.evaluate(snapshot);
      requests.length = 0;
      await armInteraction(page);
      await page.evaluate(watchSwitch, destination);
      await linkTo(page, destination).click();
      const times = await readSwitch(page);
      for (const [step, ms] of Object.entries(times))
        recorder.add(`to-${destination}-${step}-${phase}`, ms);
      // The row it left lets go of both the highlight and aria-current.
      expect.soft(await page.evaluate(rowStillLit, destination)).toBe(false);
      if (phase === "first")
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `${destination}-after-switch`,
        );
      const homeLoads = await logSwitch(page, destination, before, requests);
      // One open of Today is one Gmail read at most, however it was reached.
      expect.soft(homeLoads).toBeLessThanOrEqual(1);
    };

    for (let run = 0; run <= perfRuns; run++) {
      const phase = run === 0 ? "first" : "repeat";
      for (const destination of ["today", "inbox"] as const)
        await switchTo(destination, phase);
    }

    // A new session in the same browser: Today opens on what it last showed.
    await page.goto(inbox);
    await page.waitForFunction(firstInboxRowVisible, undefined, {
      timeout: 60_000,
    });
    await waitForEngineIdle(page);
    // A person takes a moment before reaching for Today; by then the page
    // has fetched Today's route, which is what this measures past.
    await page.waitForTimeout(2000);
    await switchTo("today", "reload");
    recorder.add("today-cache-bytes", await page.evaluate(cachedTodayBytes));
  } catch (error) {
    testInfo.annotations.push({ type: "failed-at", description: page.url() });
    await page.screenshot({ path: testInfo.outputPath("switch-failure.png") });
    throw error;
  } finally {
    await context.close();
    await recorder.attach(testInfo, "today-inbox-switch");
  }

  const repeat = (flow: string) => recorder.median(`${flow}-repeat`);
  expect
    .soft(repeat("to-today-highlight"))
    .toBeLessThan(SWITCH_BUDGETS_MS.highlight);
  expect
    .soft(repeat("to-inbox-highlight"))
    .toBeLessThan(SWITCH_BUDGETS_MS.highlight);
  expect
    .soft(repeat("to-today-shown"))
    .toBeLessThan(SWITCH_BUDGETS_MS.todayShown);
  expect
    .soft(repeat("to-today-content"))
    .toBeLessThan(SWITCH_BUDGETS_MS.todayContent);
  expect
    .soft(repeat("to-inbox-shown"))
    .toBeLessThan(SWITCH_BUDGETS_MS.inboxShown);
  expect
    .soft(repeat("to-inbox-content"))
    .toBeLessThan(SWITCH_BUDGETS_MS.inboxContent);
  expect
    .soft(recorder.median("to-today-content-reload"))
    .toBeLessThan(SWITCH_BUDGETS_MS.todayContent);
});

/** Whether the row the switch left still shows as current in any way. */
function rowStillLit(destination: Destination) {
  const left = destination === "today" ? /^Inbox/ : /^Today/;
  for (const link of document.querySelectorAll(
    'a[data-highlighted], a[aria-current="page"]',
  ))
    if (left.test(link.textContent?.trim() ?? "")) return true;
  return false;
}

/** The size of Today's saved copy in this browser. */
function cachedTodayBytes() {
  let bytes = 0;
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("cue:today:"))
      bytes += key.length + (window.localStorage.getItem(key)?.length ?? 0);
  }
  return bytes;
}

function linkTo(page: Page, destination: Destination) {
  return destination === "today"
    ? page.getByRole("link", { name: "Today", exact: true })
    : page.getByRole("link", { name: /^Inbox/ }).first();
}

/**
 * Times each step of a switch in the page, from the input event to the first
 * animation frame that shows it, so Playwright's own round trips never count:
 * the sidebar highlighting the clicked row, the address changing, the
 * destination's frame, and its content.
 */
function watchSwitch(destination: Destination) {
  const state = window as unknown as {
    __perfT0?: number;
    __ttSwitch?: { times: Record<string, number>; done: boolean };
  };
  const watch = { times: {} as Record<string, number>, done: false };
  state.__ttSwitch = watch;
  const isToday = destination === "today";
  const checks: Record<string, () => boolean> = {
    highlight: () => {
      const name = isToday ? /^Today/ : /^Inbox/;
      for (const link of document.querySelectorAll(
        'a[data-highlighted], a[aria-current="page"]',
      ))
        if (name.test(link.textContent?.trim() ?? "")) return true;
      return false;
    },
    url: () =>
      isToday
        ? window.location.pathname.endsWith("/home")
        : window.location.pathname.startsWith("/mail/u/"),
    shown: () =>
      isToday
        ? Array.from(document.querySelectorAll("h1, h2, [role=heading]")).some(
            (heading) =>
              /^Good (morning|afternoon|evening)/.test(
                heading.textContent ?? "",
              ),
          )
        : Boolean(
            document.querySelector(
              '[role="listbox"][aria-label="Conversations"]',
            ),
          ),
    content: () => {
      if (isToday)
        return Boolean(
          document.querySelector("[data-today-thread]") ||
            document.body.innerText.includes("All clear."),
        );
      const row = document.querySelector(
        '[role="listbox"][aria-label="Conversations"] [data-mail-thread-row]',
      );
      return Boolean(row && row.getBoundingClientRect().height > 0);
    },
  };
  const deadline = performance.now() + 45_000;
  const frame = (now: number) => {
    const start = state.__perfT0;
    if (start !== undefined)
      for (const [step, holds] of Object.entries(checks))
        if (watch.times[step] === undefined && holds())
          watch.times[step] = Math.round(now - start);
    watch.done =
      Object.keys(watch.times).length === Object.keys(checks).length ||
      now > deadline;
    if (!watch.done) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function readSwitch(page: Page): Promise<SwitchTimes> {
  const handle = await page.waitForFunction(
    () => {
      const watch = (
        window as unknown as {
          __ttSwitch?: { times: SwitchTimes; done: boolean };
        }
      ).__ttSwitch;
      return watch?.done ? watch.times : false;
    },
    undefined,
    { timeout: 60_000 },
  );
  const times = (await handle.jsonValue()) as SwitchTimes;
  for (const step of ["highlight", "url", "shown", "content"] as const)
    if (times[step] === undefined) throw new Error(`The switch never ${step}`);
  return times;
}

/**
 * Logs what the switch cost besides time: whether the sidebar and list were
 * rebuilt, whether the mail engine restarted, and what it asked the server.
 * Returns how many times it loaded Today's lanes.
 */
async function logSwitch(
  page: Page,
  destination: Destination,
  before: Snapshot,
  requests: Request[],
) {
  // Requests the switch sets off a moment later still count.
  await page.waitForTimeout(1500);
  const after = await page.evaluate(snapshot);
  const detail = {
    remountedSidebar: !after.sidebarTagged,
    remountedList: !after.listTagged,
    workersCreated: after.workers - before.workers,
    longTaskMs: Math.round(after.longTaskMs - before.longTaskMs),
    requests: requests
      .map((request) => {
        const headers = request.headers();
        const kind = headers.rsc
          ? headers["next-router-prefetch"] ||
            headers["next-router-segment-prefetch"]
            ? "rsc-prefetch"
            : "rsc"
          : request.resourceType();
        return `${kind} ${request.method()} ${new URL(request.url()).pathname}`;
      })
      .filter((line) => /^(rsc|document|fetch)/.test(line)),
  };
  console.log(`SWITCH to-${destination} ${JSON.stringify(detail)}`);
  return requests.filter(
    (request) => new URL(request.url()).pathname === "/api/user/home",
  ).length;
}

type Snapshot = {
  sidebarTagged: boolean;
  listTagged: boolean;
  workers: number;
  longTaskMs: number;
};

function snapshot(): Snapshot {
  const tagged = (selector: string) =>
    Boolean(
      (document.querySelector(selector) as (Element & { __tt?: true }) | null)
        ?.__tt,
    );
  const state = window as unknown as {
    __ttWorkers?: number;
    __perfVitals?: { longTaskMs: number };
  };
  return {
    sidebarTagged: tagged('nav[aria-label="Mailboxes"]'),
    listTagged: tagged('[role="listbox"][aria-label="Conversations"]'),
    workers: state.__ttWorkers ?? 0,
    longTaskMs: state.__perfVitals?.longTaskMs ?? 0,
  };
}

/** Marks the sidebar and list, so a rebuilt one shows up unmarked. */
function tagMounted() {
  for (const selector of [
    'nav[aria-label="Mailboxes"]',
    '[role="listbox"][aria-label="Conversations"]',
  ])
    for (const element of document.querySelectorAll(selector))
      (element as Element & { __tt?: true }).__tt = true;
}

/** Counts workers started, so a mail engine restart shows up. */
function countWorkers() {
  const state = window as unknown as { __ttWorkers?: number };
  state.__ttWorkers = 0;
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      state.__ttWorkers = (state.__ttWorkers ?? 0) + 1;
    }
  };
}
