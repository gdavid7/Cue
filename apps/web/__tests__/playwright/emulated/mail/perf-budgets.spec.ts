import { type BrowserContext, expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { test } from "../playwright-test";
import { buildMailPath } from "@/utils/mail-url";
import { readProviderAccessToken, withClient } from "./mail-test-helpers";
import {
  PERF_BUDGETS_MS,
  PerfRecorder,
  armInteraction,
  editorReady,
  firstInboxRowVisible,
  firstRowSubject,
  headingMatches,
  newPerfContext,
  newPerfPage,
  pageShowsText,
  perfProfile,
  perfRuns,
  readVitals,
  readerShowsText,
  rowWithSubjectGone,
  rowWithSubjectMatches,
  timeSinceInput,
  timeSinceNavigation,
  waitForEngineIdle,
} from "./perf-test-helpers";

// Gmail-level speed is a product requirement, so the flows people repeat all
// day carry budgets. Timings run in the page, from the input event to the
// animation frame that shows the result. `perf/playwright.config.mjs` reruns
// these against a large mailbox with more repetitions to produce a report.
const inbox = buildMailPath({ accountIndex: 0 });

test("inbox paints its rows quickly on a cold and a warm load", async ({
  browser,
}, testInfo) => {
  // Each run waits for a full first sync and the provider quota to refill.
  test.setTimeout(300_000 + perfRuns * 360_000);
  const recorder = new PerfRecorder();
  // Each cold load syncs the account from scratch. The provider quota refills
  // per minute, so a first sync straight after another would measure the
  // quota wait instead of a person's first visit: without a cooldown between
  // them, one cold load is measured and the rest of the runs are warm.
  const cooldownMs = Number(process.env.PERF_COLD_COOLDOWN_MS ?? 0);
  const coldRuns = cooldownMs > 0 ? perfRuns : 1;
  let context: BrowserContext | undefined;
  try {
    for (let run = 0; run < perfRuns; run++) {
      if (run < coldRuns) {
        await context?.close();
        if (run > 0) await sleep(cooldownMs);
        context = await newPerfContext(browser);
        // Cold: no HTTP cache, no service worker and no local mailbox.
        const cold = await newPerfPage(context, { network: true });
        await cold.goto(inbox, { waitUntil: "commit" });
        recorder.add(
          "cold-inbox-rows",
          await timeSinceNavigation(
            cold,
            firstInboxRowVisible,
            undefined,
            180_000,
          ),
        );
        // The server's placeholder rows count above; the engine's own list,
        // which can select and triage, is timed on its own.
        recorder.add(
          "cold-engine-rows",
          await timeSinceNavigation(
            cold,
            firstEngineRowVisible,
            undefined,
            180_000,
          ),
        );
        const coldVitals = await readVitals(cold);
        recorder.add("cold-lcp", coldVitals.lcp);
        recorder.add("cold-ttfb", coldVitals.ttfb);
        recorder.add("cold-cls-x1000", coldVitals.cls * 1000);
        recorder.add("cold-long-tasks", coldVitals.longTaskMs);
        await waitForEngineIdle(cold);
        await cold.close();
      }
      if (!context) throw new Error("No cold load opened a browser");

      // Warm: the mailbox, scripts and service worker are already local.
      const warm = await newPerfPage(context);
      await warm.goto(inbox, { waitUntil: "commit" });
      recorder.add(
        "warm-inbox-rows",
        await timeSinceNavigation(warm, firstInboxRowVisible, undefined),
      );
      recorder.add(
        "warm-engine-rows",
        await timeSinceNavigation(warm, firstEngineRowVisible, undefined),
      );
      const warmVitals = await readVitals(warm);
      recorder.add("warm-lcp", warmVitals.lcp);
      recorder.add("warm-ttfb", warmVitals.ttfb);
      recorder.add("warm-cls-x1000", warmVitals.cls * 1000);
      recorder.add("warm-long-tasks", warmVitals.longTaskMs);
      await warm.close();
    }
  } finally {
    await context?.close();
    await recorder.attach(testInfo, "load");
  }
  expect(recorder.median("cold-inbox-rows")).toBeLessThan(
    PERF_BUDGETS_MS.coldInboxRows,
  );
  expect(recorder.median("warm-inbox-rows")).toBeLessThan(
    PERF_BUDGETS_MS.warmInboxRows,
  );
});

test("opening, triaging, switching and searching respond within budget", async ({
  browser,
}, testInfo) => {
  test.setTimeout(900_000);
  const recorder = new PerfRecorder();
  const context = await newPerfContext(browser);
  const page = await newPerfPage(context);
  try {
    await page.goto(inbox);
    await page.waitForFunction(firstInboxRowVisible, undefined, {
      timeout: 60_000,
    });
    await waitForEngineIdle(page);
    const inboxFirst = await page.evaluate(firstRowSubject);
    const inboxTop = await page.evaluate(topRowSubjects);

    for (let run = 0; run < perfRuns; run++) {
      // Open the next conversation, then reopen it once it is local.
      await page.keyboard.press("j");
      const subject = await focusedSubject(page);
      for (const flow of ["open-email-first", "open-email-cached"]) {
        await armInteraction(page);
        await page.keyboard.press("Enter");
        recorder.add(
          flow,
          await timeSinceInput(
            page,
            readerShowsText,
            subject.replace(/^Re: /, ""),
          ),
        );
        await page.keyboard.press("Escape");
        await page.waitForFunction(firstInboxRowVisible, undefined);
      }

      // Triage the next conversation, one this run has not opened: opening
      // one marks it read, and a read toggle straight after would race that.
      await page.keyboard.press("j");
      const target = await focusedSubject(page);
      const isStarred = await rowHasText(page, target, "Starred conversation");
      await armInteraction(page);
      await page.keyboard.press("s");
      recorder.add(
        "star",
        await timeSinceInput(page, rowWithSubjectMatches, {
          subject: target,
          text: "Starred conversation",
          present: !isStarred,
        }),
      );
      await page.keyboard.press("s");

      const isUnread = await rowHasText(page, target, "Unread,");
      await armInteraction(page);
      await page.keyboard.press(isUnread ? "Shift+I" : "Shift+U");
      recorder.add(
        "mark-read",
        await timeSinceInput(page, rowWithSubjectMatches, {
          subject: target,
          text: "Unread,",
          present: !isUnread,
        }),
      );
      await page.keyboard.press(isUnread ? "Shift+U" : "Shift+I");

      await armInteraction(page);
      await page.keyboard.press("e");
      recorder.add(
        "archive",
        await timeSinceInput(page, rowWithSubjectGone, target),
      );
      await page.keyboard.press("z");
      await page.waitForFunction(
        rowWithSubjectMatches,
        { subject: target, text: "", present: true },
        { timeout: 20_000 },
      );

      // Sent and back to the inbox, each judged by its top rows: the newest
      // conversation can lead both views when the person replied to it last.
      await armInteraction(page);
      await goToView(page, "Sent");
      recorder.add(
        "switch-view",
        await timeSinceInput(page, topRowsAreNot, inboxTop),
      );
      await armInteraction(page);
      await goToView(page, "Inbox");
      recorder.add(
        "switch-view",
        await timeSinceInput(page, topRowsAre, inboxTop),
      );

      // Search: the first matching result on screen.
      const term = searchTerms[run % searchTerms.length];
      const search = page.getByPlaceholder("Search mail");
      await search.fill(term);
      await armInteraction(page);
      await search.press("Enter");
      recorder.add(
        "search",
        await timeSinceInput(page, firstRowSubjectIncludes, term),
      );
      await page.getByRole("button", { name: "Clear search" }).click();
      await page.waitForFunction(firstRowSubjectIs, inboxFirst);

      // Compose: the editor on screen, ready for typing.
      await armInteraction(page);
      await page.keyboard.press("c");
      recorder.add(
        "compose",
        await timeSinceInput(page, editorReady, undefined),
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const vitals = await readVitals(page);
    recorder.add("session-inp", vitals.inp);
    recorder.add("session-long-tasks", vitals.longTaskMs);
    recorder.add("session-longest-task", vitals.longestTaskMs);
  } catch (error) {
    testInfo.annotations.push({ type: "failed-at", description: page.url() });
    await page.screenshot({ path: testInfo.outputPath("perf-failure.png") });
    throw error;
  } finally {
    await context.close();
    // Partial results still help when a later flow fails.
    await recorder.attach(testInfo, "interactions");
  }
  expect
    .soft(recorder.median("open-email-cached"))
    .toBeLessThan(PERF_BUDGETS_MS.openCachedEmail);
  expect.soft(recorder.median("archive")).toBeLessThan(PERF_BUDGETS_MS.archive);
  expect.soft(recorder.median("star")).toBeLessThan(PERF_BUDGETS_MS.star);
  expect
    .soft(recorder.median("mark-read"))
    .toBeLessThan(PERF_BUDGETS_MS.markRead);
  expect
    .soft(recorder.median("switch-view"))
    .toBeLessThan(PERF_BUDGETS_MS.switchView);
  expect.soft(recorder.median("search")).toBeLessThan(PERF_BUDGETS_MS.search);
  expect.soft(recorder.median("compose")).toBeLessThan(PERF_BUDGETS_MS.compose);
});

test("Today, Rules, Settings and chat are ready quickly", async ({
  browser,
}, testInfo) => {
  test.setTimeout(900_000);
  const recorder = new PerfRecorder();
  const context = await newPerfContext(browser);
  const page = await newPerfPage(context);
  const chatReply = `Perf chat reply ${Date.now()}`;
  await registerLlmReply({ match: "perf chat probe", text: chatReply });
  try {
    await page.goto(inbox);
    await page.waitForFunction(firstInboxRowVisible, undefined, {
      timeout: 60_000,
    });
    const emailAccountId = await getEmailAccountId(page);
    // A phone has no sidebar, so its screens are measured as page loads.
    const viaLink = perfProfile === "laptop";
    for (let run = 0; run < perfRuns; run++) {
      for (const [flow, link, path, heading] of [
        ["today", "Today", "home", "^Good (morning|afternoon|evening)"],
        ["rules", "Rules", "automation", "^Rules$"],
      ] as const) {
        if (viaLink) {
          await armInteraction(page);
          await page.getByRole("link", { name: link, exact: true }).click();
          recorder.add(
            flow,
            await timeSinceInput(page, headingMatches, heading),
          );
        } else {
          await page.goto(`/${emailAccountId}/${path}`, {
            waitUntil: "commit",
          });
          recorder.add(
            `${flow}-load`,
            await timeSinceNavigation(page, headingMatches, heading),
          );
        }
      }

      await page.goto("/settings", { waitUntil: "commit" });
      recorder.add(
        "settings-load",
        await timeSinceNavigation(page, headingMatches, "^Settings$"),
      );

      if (viaLink) {
        // Settings was a full page load. A click before React hydrates the
        // link is a plain document navigation, which resets the timer.
        const chatLink = page.getByRole("link", { name: "Chat", exact: true });
        await expect
          .poll(() =>
            chatLink.evaluate((element) =>
              Object.keys(element).some((key) =>
                key.startsWith("__reactProps$"),
              ),
            ),
          )
          .toBe(true);
        await armInteraction(page);
        await chatLink.click();
        recorder.add(
          "chat-ready",
          await timeSinceInput(page, chatInputReady, undefined),
        );
      } else {
        await page.goto(`/${emailAccountId}/assistant`, {
          waitUntil: "commit",
        });
        recorder.add(
          "chat-ready-load",
          await timeSinceNavigation(page, chatInputReady, undefined),
        );
      }
      await page.getByTestId("chat-input").fill(`perf chat probe ${run}`);
      await armInteraction(page);
      // On a touchscreen Return is a newline; the send button submits.
      if (perfProfile === "phone") {
        await page.getByRole("button", { name: "Send message" }).click();
      } else {
        await page.getByTestId("chat-input").press("Enter");
      }
      recorder.add(
        "chat-first-token",
        await timeSinceInput(page, pageShowsText, chatReply, 30_000),
      );
      await page.goto(inbox);
      await page.waitForFunction(firstInboxRowVisible, undefined, {
        timeout: 60_000,
      });
    }
  } catch (error) {
    testInfo.annotations.push({ type: "failed-at", description: page.url() });
    await page.screenshot({ path: testInfo.outputPath("perf-failure.png") });
    throw error;
  } finally {
    await context.close();
    // Partial results still help when a later flow fails.
    await recorder.attach(testInfo, "pages");
  }
});

// Someone who just signed in: the app's service worker is installed from the
// sign-in pages, but there is no local mailbox yet. Harness only, as each run
// syncs the account from scratch.
test("inbox paints quickly right after sign-in", async ({
  browser,
}, testInfo) => {
  test.skip(
    process.env.PERF_MAILBOX !== "large",
    "Runs only in the perf harness",
  );
  test.setTimeout(300_000 + perfRuns * 360_000);
  const recorder = new PerfRecorder();
  const cooldownMs = Number(process.env.PERF_COLD_COOLDOWN_MS ?? 0);
  try {
    for (let run = 0; run < perfRuns; run++) {
      if (run > 0) await sleep(cooldownMs);
      const context = await newPerfContext(browser);
      try {
        const settings = await newPerfPage(context);
        await settings.goto("/settings");
        await settings.waitForFunction(
          () => navigator.serviceWorker?.controller,
          undefined,
          { timeout: 180_000 },
        );
        await settings.close();
        const page = await newPerfPage(context, { network: true });
        await page.goto(inbox, { waitUntil: "commit" });
        recorder.add(
          "signin-inbox-rows",
          await timeSinceNavigation(page, firstInboxRowVisible, undefined),
        );
        recorder.add(
          "signin-engine-rows",
          await timeSinceNavigation(
            page,
            firstEngineRowVisible,
            undefined,
            180_000,
          ),
        );
        const vitals = await readVitals(page);
        recorder.add("signin-ttfb", vitals.ttfb);
        recorder.add("signin-cls-x1000", vitals.cls * 1000);
        await waitForEngineIdle(page);
      } finally {
        await context.close();
      }
    }
  } finally {
    await recorder.attach(testInfo, "signin");
  }
});

// Only the large perf mailbox runs this: it resets the account's signature and
// adds mail to the provider, which the shared suite's other specs don't expect.
test("first compose, mail that arrived while closed, and list input are quick", async ({
  browser,
}, testInfo) => {
  test.skip(
    process.env.PERF_MAILBOX !== "large",
    "Runs only in the perf harness",
  );
  test.setTimeout(900_000);
  const recorder = new PerfRecorder();
  const context = await newPerfContext(browser);
  let page = await newPerfPage(context);
  try {
    await page.goto(inbox);
    await page.waitForFunction(firstEngineRowVisible, undefined, {
      timeout: 180_000,
    });
    await waitForEngineIdle(page);
    await page.close();

    for (let run = 0; run < perfRuns; run++) {
      // The first compose after sign-in, while the signature was never read
      // from Gmail: someone who opens Cue and starts writing a second later.
      await resetSignature();
      page = await newPerfPage(context);
      await page.goto(inbox, { waitUntil: "commit" });
      await page.waitForFunction(firstEngineRowVisible, undefined, {
        timeout: 60_000,
      });
      await page.waitForTimeout(1000);
      await armInteraction(page);
      await page.keyboard.press("c");
      recorder.add(
        "first-compose",
        await timeSinceInput(page, editorReady, undefined, 30_000),
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.close();

      // Mail that arrived while Cue was closed, then Cue opened.
      const subject = `Perf arrival ${Date.now()}`;
      await insertNewMail(subject);
      await sleep(1000);
      page = await newPerfPage(context);
      await page.goto(inbox, { waitUntil: "commit" });
      recorder.add(
        "new-mail-first-row",
        await timeSinceNavigation(page, firstEngineRowVisible, undefined),
      );
      recorder.add(
        "new-mail-on-open",
        await timeSinceNavigation(page, rowWithSubjectShown, subject, 60_000),
      );
      await page.waitForTimeout(2000);
      recorder.add("new-mail-cls-x1000", (await readVitals(page)).cls * 1000);

      // Moving through the list and archiving, judged by the focused row.
      await waitForEngineIdle(page);
      for (let step = 0; step < 5; step++) {
        const before = await focusedSubject(page).catch(() => "");
        await armInteraction(page);
        await page.keyboard.press("j");
        recorder.add(
          "list-nav",
          await timeSinceInput(page, focusedSubjectIsNot, before),
        );
      }
      for (let step = 0; step < 2; step++) {
        const target = await focusedSubject(page);
        await armInteraction(page);
        await page.keyboard.press("e");
        recorder.add(
          "archive-input",
          await timeSinceInput(page, rowWithSubjectGone, target),
        );
        await page.keyboard.press("z");
        await page
          .waitForFunction(
            rowWithSubjectMatches,
            { subject: target, text: "", present: true },
            { timeout: 20_000 },
          )
          .catch(async (error: unknown) => {
            console.log(
              `PERF-UNDO-FAILED ${JSON.stringify(await describeUndoState(page, target))}`,
            );
            throw error;
          });
      }
      const vitals = await readVitals(page);
      recorder.add("list-inp", vitals.inp);
      recorder.add("list-longest-task", vitals.longestTaskMs);
      await page.close();
    }
  } catch (error) {
    testInfo.annotations.push({ type: "failed-at", description: page.url() });
    await page
      .screenshot({ path: testInfo.outputPath("perf-failure.png") })
      .catch(() => undefined);
    throw error;
  } finally {
    await context.close();
    await recorder.attach(testInfo, "arrivals");
  }
});

// What the screen and the mail engine show when an undo does not bring the
// archived conversation back, so a failure says which side lost it.
async function describeUndoState(page: Page, subject: string) {
  return page.evaluate(async (subject) => {
    const subjects = Array.from(
      document.querySelectorAll("[data-mail-thread-subject]"),
      (element) => element.textContent ?? "",
    );
    const inspect = (await window.__inboxZeroMailInspect
      ?.read()
      .catch(() => null)) as Record<string, unknown> | null;
    return {
      rowsShown: subjects.length,
      targetShown: subjects.includes(subject),
      inPreview: Boolean(document.querySelector("[data-mail-inbox-preview]")),
      toasts: Array.from(
        document.querySelectorAll("[data-sonner-toast]"),
        (toast) => (toast.textContent ?? "").slice(0, 80),
      ),
      focused: document.activeElement?.tagName,
      inspectKeys: inspect ? Object.keys(inspect) : null,
      pending: inspect
        ? JSON.stringify(
            (inspect as { commands?: unknown; outbox?: unknown }).commands ??
              (inspect as { outbox?: unknown }).outbox ??
              null,
          ).slice(0, 600)
        : null,
    };
  }, subject);
}

async function resetSignature() {
  await withClient((client) =>
    client.query(
      `UPDATE "EmailAccount" SET signature = NULL WHERE email = $1`,
      [process.env.PLAYWRIGHT_TEST_EMAIL],
    ),
  );
}

async function insertNewMail(subject: string) {
  const token = await readProviderAccessToken();
  const response = await fetch(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "Arrivals <arrivals@example.com>",
        to: process.env.PLAYWRIGHT_TEST_EMAIL,
        subject,
        body_text: "Mail that arrived while Cue was closed.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      }),
    },
  );
  expect(response.ok).toBe(true);
}

function firstEngineRowVisible() {
  for (const row of document.querySelectorAll(
    '[role="listbox"][aria-label="Conversations"] [data-mail-thread-row]',
  )) {
    if (
      !row.closest("[data-mail-inbox-preview]") &&
      row.getBoundingClientRect().height > 0
    )
      return performance.now();
  }
  return false;
}

function rowWithSubjectShown(subject: string) {
  for (const element of document.querySelectorAll("[data-mail-thread-subject]"))
    if (element.textContent === subject) return performance.now();
  return false;
}

function focusedSubjectIsNot(previous: string) {
  const subject = document.querySelector(
    '[data-mail-thread-row][tabindex="0"] [data-mail-thread-subject]',
  )?.textContent;
  return subject && subject !== previous ? performance.now() : false;
}

/** The sidebar on a laptop; the go-to shortcut on a phone, which has none. */
async function goToView(page: Page, view: "Inbox" | "Sent") {
  if (perfProfile === "laptop") {
    await page.getByRole("link", { name: new RegExp(`^${view}`) }).click();
    return;
  }
  await page.keyboard.press("g");
  await page.keyboard.press(view === "Sent" ? "t" : "i");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatInputReady() {
  return document.querySelector('[data-testid="chat-input"]')
    ? performance.now()
    : false;
}

async function registerLlmReply(reply: { match: string; text: string }) {
  const response = await fetch(
    `${process.env.PLAYWRIGHT_LLM_BASE_URL}/__emulator/replies`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reply),
    },
  );
  expect(response.ok).toBe(true);
}

const searchTerms =
  process.env.PERF_MAILBOX === "large"
    ? ["invoice", "meeting", "launch", "travel", "hiring"]
    : // Not "Playwright Test": the account's own address contains it, so on
      // Outlook newer drafts and sent mail to that address rightly lead
      // the results.
      ["Archive Action", "Keyboard Navigation", "Reader Navigation"];

function firstRowSubjectIs(subject: string) {
  const first = document.querySelector(
    '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
  );
  return first?.textContent === subject ? performance.now() : false;
}

function topRowSubjects() {
  return Array.from(
    document.querySelectorAll(
      '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
    ),
    (row) => row.textContent,
  )
    .slice(0, 3)
    .join("\n");
}

function topRowsAre(expected: string) {
  const top = Array.from(
    document.querySelectorAll(
      '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
    ),
    (row) => row.textContent,
  )
    .slice(0, 3)
    .join("\n");
  return top === expected ? performance.now() : false;
}

function topRowsAreNot(previous: string) {
  const top = Array.from(
    document.querySelectorAll(
      '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
    ),
    (row) => row.textContent,
  )
    .slice(0, 3)
    .join("\n");
  return top && top !== previous ? performance.now() : false;
}

function firstRowSubjectIncludes(text: string) {
  const first = document.querySelector(
    '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
  );
  return first?.textContent?.toLowerCase().includes(text.toLowerCase())
    ? performance.now()
    : false;
}

async function focusedSubject(page: Page) {
  const subject = await page
    .locator('[data-mail-thread-row][tabindex="0"] [data-mail-thread-subject]')
    .first()
    .textContent();
  if (!subject) throw new Error("No focused conversation");
  return subject;
}

async function rowHasText(page: Page, subject: string, text: string) {
  return page.evaluate(
    ({ subject, text }) => {
      for (const element of document.querySelectorAll(
        "[data-mail-thread-subject]",
      )) {
        if (element.textContent !== subject) continue;
        return (
          element.closest("[data-mail-thread-row]")?.textContent ?? ""
        ).includes(text);
      }
      return false;
    },
    { subject, text },
  );
}
