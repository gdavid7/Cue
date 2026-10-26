import { type BrowserContext, expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { test } from "../playwright-test";
import { buildMailPath } from "@/utils/mail-url";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
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
  readEngineTimeline,
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
        // A cold wait that times out says where it stopped: the engine's
        // marks and requests are logged before the failure is rethrown.
        try {
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
        } catch (error) {
          await logStalledLoad(cold, "cold", recorder);
          throw error;
        }
        for (const [phase, at] of Object.entries(
          await readEngineTimeline(cold),
        )) {
          recorder.add(`cold-engine-${phase}`, at);
        }
        for (const { name, end } of await readAppMeasures(cold)) {
          recorder.add(`cold-${name}`, end);
        }
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
      try {
        recorder.add(
          "warm-inbox-rows",
          await timeSinceNavigation(warm, firstInboxRowVisible, undefined),
        );
        recorder.add(
          "warm-engine-rows",
          await timeSinceNavigation(warm, firstEngineRowVisible, undefined),
        );
      } catch (error) {
        await logStalledLoad(warm, "warm", recorder);
        throw error;
      }
      for (const [phase, at] of Object.entries(
        await readEngineTimeline(warm),
      )) {
        recorder.add(`warm-engine-${phase}`, at);
      }
      for (const { name, end } of await readAppMeasures(warm)) {
        recorder.add(`warm-${name}`, end);
      }
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
      // Each pass sends about seven changes through one serial queue at the
      // account's Gmail pace; without this the third pass's undo queues
      // behind the first two and can miss its 20 s wait.
      await waitForSentChanges(page);
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
        // The first visit has no saved Today to open on; later ones do.
        const inboxRows = `today-${run === 0 ? "first" : "saved"}-inbox-rows`;
        if (viaLink) {
          await armInteraction(page);
          await page.getByRole("link", { name: link, exact: true }).click();
          recorder.add(
            flow,
            await timeSinceInput(page, headingMatches, heading),
          );
          if (flow === "today")
            recorder.add(
              inboxRows,
              await timeSinceInput(page, alsoInInboxRowVisible, undefined),
            );
        } else {
          await page.goto(`/${emailAccountId}/${path}`, {
            waitUntil: "commit",
          });
          recorder.add(
            `${flow}-load`,
            await timeSinceNavigation(page, headingMatches, heading),
          );
          if (flow === "today")
            recorder.add(
              `${inboxRows}-load`,
              await timeSinceNavigation(page, alsoInInboxRowVisible, undefined),
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
        for (const [phase, at] of Object.entries(
          await readEngineTimeline(page),
        )) {
          recorder.add(`signin-engine-${phase}`, at);
        }
        const vitals = await readVitals(page);
        recorder.add("signin-ttfb", vitals.ttfb);
        recorder.add("signin-fcp", vitals.fcp);
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

// RL-1: a laptop opened again after days away. Meanwhile the mail was
// triaged elsewhere (Gmail history to replay) and new mail arrived; the
// newest of it should show within seconds, not after the replay.
const RETURNING_AGE_MS = 3 * 24 * 60 * 60_000;
const RETURNING_NEW_MESSAGES = 40;
const RETURNING_RELABELED = 300;
const FIRST_SCREEN = 15;

test("a mailbox opened after days away shows its newest mail first", async ({
  browser,
}, testInfo) => {
  test.skip(
    process.env.PERF_MAILBOX !== "large",
    "Runs only in the perf harness",
  );
  test.setTimeout(1_200_000);
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
      const subjects = await arriveWhileAway(`Returning ${run}`, run);
      await ageLocalMailbox(context);
      page = await newPerfPage(context);
      const insights = countRequests(page, "/api/user/inbox-insights");
      await page.goto(inbox, { waitUntil: "commit" });
      recorder.add(
        "returning-newest-row",
        await timeSinceNavigation(
          page,
          rowWithSubjectShown,
          subjects.at(-1)!,
          180_000,
        ),
      );
      recorder.add(
        "returning-first-screen",
        await timeSinceNavigation(
          page,
          rowsWithSubjectsShown,
          subjects.slice(-FIRST_SCREEN),
          180_000,
        ),
      );
      recorder.add(
        "returning-all-new",
        await timeSinceNavigation(
          page,
          rowsWithSubjectsShown,
          subjects,
          240_000,
        ),
      );
      await waitSinceNavigation(page, 60_000);
      recorder.add("returning-insights-requests-60s", insights.count());
      await page.close();
    }
  } finally {
    await context.close();
    await recorder.attach(testInfo, "returning");
  }
});

test("two accounts opened after days away both show their newest mail", async ({
  browser,
}, testInfo) => {
  test.skip(
    process.env.PERF_MAILBOX !== "large",
    "Runs only in the perf harness",
  );
  test.setTimeout(1_500_000);
  const recorder = new PerfRecorder();
  const context = await newPerfContext(browser);
  let page = await newPerfPage(context);
  const primaryId = await withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM "EmailAccount" WHERE email = $1`,
      [process.env.PLAYWRIGHT_TEST_EMAIL],
    );
    return result.rows[0]!.id;
  });
  const second = await createSecondEmailAccount(primaryId);
  const secondInbox = buildMailPath({ accountIndex: 1 });
  try {
    // Both accounts read the same emulated mailbox; each syncs its own copy.
    for (const address of [inbox, secondInbox]) {
      await page.goto(address);
      await page.waitForFunction(firstEngineRowVisible, undefined, {
        timeout: 240_000,
      });
      await waitForEngineIdle(page);
    }
    await page.close();

    for (let run = 0; run < perfRuns; run++) {
      const subjects = await arriveWhileAway(`Two accounts ${run}`, run);
      await ageLocalMailbox(context);
      page = await newPerfPage(context);
      const insights = countRequests(page, "/api/user/inbox-insights");
      await page.goto(inbox, { waitUntil: "commit" });
      recorder.add(
        "two-accounts-viewed-newest-row",
        await timeSinceNavigation(
          page,
          rowWithSubjectShown,
          subjects.at(-1)!,
          180_000,
        ),
      );
      recorder.add(
        "two-accounts-viewed-first-screen",
        await timeSinceNavigation(
          page,
          rowsWithSubjectsShown,
          subjects.slice(-FIRST_SCREEN),
          180_000,
        ),
      );
      // Switching to the other account, which has been catching up too.
      await page.goto(secondInbox, { waitUntil: "commit" });
      recorder.add(
        "two-accounts-other-newest-row",
        await timeSinceNavigation(
          page,
          rowWithSubjectShown,
          subjects.at(-1)!,
          180_000,
        ),
      );
      recorder.add(
        "two-accounts-other-first-screen",
        await timeSinceNavigation(
          page,
          rowsWithSubjectsShown,
          subjects.slice(-FIRST_SCREEN),
          180_000,
        ),
      );
      await waitSinceNavigation(page, 30_000);
      recorder.add("two-accounts-insights-requests", insights.count());
      await page.close();
    }
  } finally {
    await context.close();
    await deleteSecondEmailAccount(second.accountId).catch(() => undefined);
    await recorder.attach(testInfo, "two-accounts");
  }
});

// Days away: older mail triaged on another device, then new mail, newest
// last. Returns the new subjects, oldest first.
async function arriveWhileAway(prefix: string, run: number) {
  const token = await readProviderAccessToken();
  const ids = Array.from(
    { length: RETURNING_RELABELED },
    (_, index) => `perf_${100 + index}_0`,
  );
  const relabel = await fetch(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/batchModify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        run % 2 === 0
          ? { ids, addLabelIds: ["UNREAD"] }
          : { ids, removeLabelIds: ["UNREAD"] },
      ),
    },
  );
  expect(relabel.ok).toBe(true);
  const stamp = Date.now();
  const subjects: string[] = [];
  for (let index = 0; index < RETURNING_NEW_MESSAGES; index++) {
    const subject = `${prefix} ${stamp} ${String(index).padStart(2, "0")}`;
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
          body_text: "Mail that arrived while this laptop was away.",
          labelIds: ["INBOX", "UNREAD"],
          internalDate: String(stamp - (RETURNING_NEW_MESSAGES - index) * 1000),
        }),
      },
    );
    expect(response.ok).toBe(true);
    subjects.push(subject);
  }
  return subjects;
}

// The browser last caught up days ago, as on a laptop left closed. Builds
// from before the cookie kept that time are left as they are.
async function ageLocalMailbox(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === "cue-local-mail",
  );
  if (!cookie?.value.includes("~")) return;
  const at = Math.floor((Date.now() - RETURNING_AGE_MS) / 1000).toString(36);
  const value = cookie.value
    .split(".")
    .map((entry) => `${entry.split("~")[0]}~${at}`)
    .join(".");
  await context.addCookies([{ ...cookie, value }]);
}

function countRequests(page: Page, path: string) {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) count += 1;
  });
  return { count: () => count };
}

async function waitSinceNavigation(page: Page, ms: number) {
  const elapsed = await page.evaluate(() => performance.now());
  if (elapsed < ms) await page.waitForTimeout(ms - elapsed);
}

function rowsWithSubjectsShown(subjects: string[]) {
  const shown = new Set(
    Array.from(
      document.querySelectorAll("[data-mail-thread-subject]"),
      (element) => element.textContent,
    ),
  );
  return subjects.every((subject) => shown.has(subject))
    ? performance.now()
    : false;
}

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

/** Best effort, like `waitForEngineIdle`: a queue still busy is measured as it is. */
async function waitForSentChanges(page: Page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(async () => {
      const diagnostics = (await window.__inboxZeroMailInspect
        ?.read()
        .catch(() => null)) as { pendingOperations?: number } | null;
      return diagnostics?.pendingOperations ?? 0;
    });
    if (pending === 0) return;
    await page.waitForTimeout(250);
  }
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

function alsoInInboxRowVisible() {
  for (const row of document.querySelectorAll(
    '[role="listbox"][aria-label="Also in your inbox"] [role="option"]',
  )) {
    if (row.getBoundingClientRect().height > 0) return performance.now();
  }
  return false;
}

/**
 * Prints and records the engine's startup marks, its requests and the app's
 * own first-row measures for a load that did not paint in time, so a failure
 * report shows which sub-phase held it up.
 */
async function logStalledLoad(
  page: Page,
  load: "cold" | "warm",
  recorder: PerfRecorder,
) {
  const timeline = await readEngineTimeline(page).catch(() => ({}));
  const measures = await readAppMeasures(page).catch(() => []);
  console.log(`PERF-STALL ${load} ${JSON.stringify({ timeline, measures })}`);
  for (const [phase, at] of Object.entries(timeline)) {
    recorder.add(`${load}-stalled-engine-${phase}`, at);
  }
}

function readAppMeasures(page: Page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("cue:"))
      .map((entry) => ({
        name: entry.name,
        end: Math.round(entry.startTime + entry.duration),
      })),
  );
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
