import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  openMail,
  readLatestMailMutation,
  readProviderAccessToken,
  seedMailFromContact,
  waitForMetadataCoverage,
  withClient,
} from "./mail-test-helpers";

// Seeded inbox conversations, put in Today's "Needs reply" lane by a tracker.
const ARCHIVE_THREAD = "thr_playwright_archive";
const REPLY_THREAD = "thr_playwright_1";
const REPLY_SUBJECT = "Playwright Test Message";
const TRACKER_PREFIX = "playwright-today-";
const TODAY_SUBSCRIPTION_ID = "playwright-today-subscription";
const NEWSLETTER_RULE_ID = "playwright-today-newsletter-rule";
const NEWSLETTER_RUN_PREFIX = "playwright-today-newsletter-run-";

test.beforeEach(async ({ page }) => {
  const emailAccountId = await getEmailAccountId(page);
  await seedNeedsReply(emailAccountId, [ARCHIVE_THREAD, REPLY_THREAD]);
});

test.afterEach(async () => {
  await withClient((client) =>
    client.query(`DELETE FROM "ThreadTracker" WHERE "messageId" LIKE $1`, [
      `${TRACKER_PREFIX}%`,
    ]),
  );
});

test("archives a conversation from Today and restores it with undo", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openToday(page);
  const row = todayRow(page, ARCHIVE_THREAD);
  const option = row.getByRole("option");
  await expect(option).toBeVisible();

  await option.hover();
  await capturePlaywrightCheckpoint(page, testInfo, "today-row-actions");
  await row.getByRole("button", { name: "Archive conversation" }).click();
  await expect(option).toHaveCount(0);
  // Focus moves on to the next row, so the keyboard keeps its place.
  await expect(page.locator('[role="option"]:focus')).toHaveCount(1);
  // The toast's Undo, while it shows, brings the row straight back.
  await page
    .getByRole("region", { name: "Notifications alt+T" })
    .getByRole("button", { name: /^Undo/ })
    .click();
  await expect(option).toBeVisible();

  // The inbox's keys work too: `e` archives the focused row, `z` undoes it.
  await option.focus();
  await page.keyboard.press("e");
  await expect(option).toHaveCount(0);
  await expectEngineMutation(page, emailAccountId, "archive");
  await page.keyboard.press("z");
  await expect(option).toBeVisible();
  await expectEngineMutation(page, emailAccountId, "unarchive");
});

test("an account without the Newsletter label bundles what Cue sorted as newsletters, on Today and in Mail", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  // Cue sorts without labelling the mailbox by default, so most accounts
  // have no Newsletter label and only Cue's own records say what's what.
  const restoreLabel = await removeNewsletterLabel(page);
  const subject = `Slow Mail digest ${Date.now()}`;
  const newsletter = await seedNewsletter(page, subject, { labelled: false });
  const emailAccountId = await getEmailAccountId(page);
  let unsort: (() => Promise<void>) | undefined;
  try {
    unsort = await sortAsNewsletter(emailAccountId, newsletter);
    await openToday(page);
    const reading = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Reading/ }) });
    await expect(
      reading.getByRole("button", { name: /^From .*Field Notes/ }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(todayRow(page, newsletter.threadId)).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "today-reading-by-cue");

    const { conversations } = await openMail(page);
    await waitForMetadataCoverage(page);
    const bundle = page.getByRole("button", {
      name: /^Reading, from .*Field Notes/,
    });
    await expect(bundle).toBeVisible({ timeout: 60_000 });
    await expect(
      conversations.getByRole("option", { name: subject }),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "mail-reading-by-cue");

    await bundle.click();
    await expect(page).toHaveURL(/\/type\/reading(\/|$|\?)/);
    const laneRow = page
      .getByRole("listbox", { name: "Conversations" })
      .getByRole("option", { name: subject });
    await expect(laneRow).toBeVisible({ timeout: 60_000 });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "mail-reading-lane-by-cue",
    );

    await page.getByRole("button", { name: "Archive all" }).click();
    await expect(page.getByText("Nothing left to read.")).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => newsletter.folderOf(), { timeout: 60_000 })
      .toBe("archive");
  } finally {
    // Each step runs whatever another throws, so the label is put back.
    await runEach([
      () => unsort?.(),
      () => newsletter.remove(),
      () => restoreLabel(),
    ]);
  }
});

test("bundles unread newsletters into one Reading row that opens in place and marks them all read", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const newsletter = await seedNewsletter(
    page,
    `Field Notes weekly ${Date.now()}`,
  );
  try {
    const { emailAccountId } = await openToday(page);
    const reading = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Reading/ }) });
    const bundle = reading.getByRole("button", { name: /^From .*Field Notes/ });
    await expect(bundle).toBeVisible({ timeout: 60_000 });
    await expect(bundle).toHaveAttribute("aria-expanded", "false");
    // One row for the bundle, not one per newsletter, and none elsewhere.
    await expect(todayRow(page, newsletter.threadId)).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "today-reading-bundled");

    await bundle.click();
    await expect(bundle).toHaveAttribute("aria-expanded", "true");
    const list = page.getByRole("listbox", { name: "Reading" });
    await expect(
      list.locator(`[data-today-thread="${newsletter.threadId}"]`),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await reading.scrollIntoViewIfNeeded();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-reading-open-${theme}-${size.width}`,
        );
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Through the mail engine, as a row's own Mark as read goes.
    await reading.getByRole("button", { name: "Mark all read" }).click();
    await expect(reading).toHaveCount(0);
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "set_read_state",
            threadId: newsletter.threadId,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });
  } finally {
    await newsletter.remove();
  }
});

test("Mail bundles newsletters into one Reading row whose lane reads through them and archives them all with undo", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const subject = `Field Notes weekly ${Date.now()}`;
  const newsletter = await seedNewsletter(page, subject);
  try {
    const { conversations } = await openMail(page);
    await waitForMetadataCoverage(page);
    const bundle = page.getByRole("button", {
      name: /^Reading, from .*Field Notes/,
    });
    await expect(bundle).toBeVisible({ timeout: 60_000 });
    // One row for the bundle; the newsletter isn't a row of its own.
    const inboxRow = conversations.getByRole("option", { name: subject });
    await expect(inboxRow).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await expect(bundle).toBeVisible();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `mail-reading-bundle-${theme}-${size.width}`,
        );
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 800 });

    await bundle.click();
    await expect(page).toHaveURL(/\/type\/reading(\/|$|\?)/);
    const laneRow = page
      .getByRole("listbox", { name: "Conversations" })
      .getByRole("option", { name: subject });
    await expect(laneRow).toBeVisible({ timeout: 60_000 });
    // The keyboard carries on from the lane's first newsletter, and the lane
    // reads as part of the inbox.
    await expect(page.locator("[data-mail-thread-row]").first()).toBeFocused();
    await expect(
      page.getByRole("link", { name: /^Inbox/ }).first(),
    ).toHaveAttribute("aria-current", "page");
    await capturePlaywrightCheckpoint(page, testInfo, "mail-reading-lane");

    // A search typed in the lane takes over: its bar and actions step aside
    // rather than act on the search's rows.
    const search = page.getByPlaceholder("Search mail or ask Cue");
    await search.fill(subject);
    await expect(page.getByRole("button", { name: "Archive all" })).toHaveCount(
      0,
    );
    await search.fill("");
    await expect(
      page.getByRole("button", { name: "Archive all" }),
    ).toBeVisible();
    await expect(laneRow).toBeVisible();

    // Reading one marks it read, and it keeps its place in the lane.
    await laneRow.click();
    await expect(page.getByRole("heading", { name: subject })).toBeVisible({
      timeout: 60_000,
    });
    await page.keyboard.press("Escape");
    await expect(laneRow).toBeVisible();

    const archiveAll = page.getByRole("button", { name: "Archive all" });
    const back = page.getByRole("button", { name: "Back to Inbox" });
    await archiveAll.click();
    await expect(laneRow).toHaveCount(0);
    await expect(back).toBeFocused();
    // Archive all keeps a row's undo, while its toast shows.
    await page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByRole("button", { name: /^Undo/ })
      .click();
    await expect(laneRow).toBeVisible({ timeout: 60_000 });

    await back.click();
    await expect(bundle).toBeFocused({ timeout: 60_000 });
    await bundle.click();
    await expect(laneRow).toBeVisible({ timeout: 60_000 });
    await archiveAll.click();
    await expect(page.getByText("Nothing left to read.")).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "mail-reading-empty");
    await expect
      .poll(() => newsletter.folderOf(), { timeout: 60_000 })
      .toBe("archive");

    // All inboxes has no lane: its Reading address goes back to the inbox.
    const allInboxesReading = new URL(page.url());
    allInboxesReading.pathname = allInboxesReading.pathname.replace(
      /\/type\/reading.*$/,
      "",
    );
    allInboxesReading.pathname += "/all-inboxes/type/reading";
    allInboxesReading.search = "";
    await page.goto(allInboxesReading.toString(), {
      waitUntil: "domcontentloaded",
    });
    await expect(page).not.toHaveURL(/\/type\/reading/, { timeout: 60_000 });
    await expect(back).toHaveCount(0);
  } finally {
    await newsletter.remove();
  }
});

test("a newsletter opened by link reads, closes and archives from the reader", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const subject = `Field Notes link ${Date.now()}`;
  const newsletter = await seedNewsletter(page, subject);
  try {
    const { emailAccountId } = await openMail(page);
    await waitForMetadataCoverage(page);
    const heading = page.getByRole("heading", { name: subject });
    const openByLink = () =>
      page.goto(`/${emailAccountId}/mail?thread-id=${newsletter.threadId}`, {
        waitUntil: "domcontentloaded",
      });

    // Bundled out of the inbox list, it still opens, and closes to the inbox.
    await openByLink();
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(heading).toHaveCount(0);
    await expect(
      page.getByRole("listbox", { name: "Conversations" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Reading, from .*Field Notes/ }),
    ).toBeVisible({ timeout: 60_000 });

    await openByLink();
    await expect(heading).toBeVisible({ timeout: 60_000 });
    expect(await newsletter.folderOf()).toBe("inbox");
    await page.keyboard.press("e");
    // Off the list, the reader moves on to the inbox's own next row.
    await expect(heading).toHaveCount(0, { timeout: 30_000 });
    // The newsletter itself left the inbox, not a row the list had focused.
    await expect
      .poll(() => newsletter.folderOf(), { timeout: 60_000 })
      .toBe("archive");
  } finally {
    await newsletter.remove();
  }
});

test("a first visit shows the inbox from local mail while Today loads", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  await waitForMetadataCoverage(page);
  // Today's answer is held, as Gmail can take seconds to give it.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    // Today's own answer only, not its other routes.
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      await released;
      await route.continue();
    },
  );

  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
  const inbox = page.getByRole("listbox", { name: "Also in your inbox" });
  await expect(inbox.getByRole("option").first()).toBeVisible({
    timeout: 60_000,
  });
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "today-local-inbox");

  release();
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
  // Each conversation shows once: what needs a reply leaves the rest.
  await expect(
    needsReply.locator(`[data-today-thread="${REPLY_THREAD}"]`),
  ).toHaveCount(1);
  await expect(
    inbox.locator(`[data-today-thread="${REPLY_THREAD}"]`),
  ).toHaveCount(0);
  await expect(
    inbox.locator(`[data-today-thread="${ARCHIVE_THREAD}"]`),
  ).toHaveCount(0);
  await expect(inbox.getByRole("option").first()).toBeVisible();
});

test("Waiting on you lists local mail from someone you write to until Needs reply has its own", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const subject = `Dinner plans ${Date.now()}`;
  const seeded = await seedMailFromContact(page, subject);
  const other = await seedMailFromContact(page, `Book club ${Date.now()}`);
  // A new mailbox: Cue hasn't read its mail, so Needs reply has nothing yet.
  let cueHasRead = false;
  await page.route(
    // Today's own answer only, not its other routes.
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      // Today refreshes while it loads; the test may end with one in flight.
      const response = await route.fetch().catch(() => null);
      if (!response) {
        await route.abort();
        return;
      }
      const home = await response.json();
      if (!cueHasRead) {
        home.cue = { aiAccess: true, replyTracking: true, hasReadMail: false };
        home.needsYou = [];
      }
      await route.fulfill({ response, json: home });
    },
  );
  const waitingOnYou = page.getByRole("listbox", {
    name: "Waiting on you",
    exact: true,
  });
  const row = waitingOnYou.locator(`[data-today-thread="${seeded.threadId}"]`);
  try {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => {
        localStorage.setItem("theme", value);
      }, theme);
      const emailAccountId = await getEmailAccountId(page);
      await page.goto(`/${emailAccountId}/home`, {
        waitUntil: "domcontentloaded",
      });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await expect(row).toContainText("May need a reply");
      await expect(
        page.getByText("From your mail, not checked by AI"),
      ).toBeVisible();
      // Each conversation shows once on Today.
      await expect(
        page
          .getByRole("listbox", { name: "Also in your inbox" })
          .locator(`[data-today-thread="${seeded.threadId}"]`),
      ).toHaveCount(0);
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await expect(row).toBeVisible();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-waiting-on-you-${theme}-${size.width}`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    }

    // A row opens in the reader, which comes back to Today.
    await row.getByRole("option").click();
    await expect(page).toHaveURL(/[?&]from=today/);
    await expect(page.getByRole("heading", { name: subject })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(page).toHaveURL(/\/home(\?|$)/);

    // Dismissed stays dismissed in this browser.
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("option").hover();
    await row.getByRole("button", { name: "Dismiss" }).first().click();
    await expect(row).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    // The other conversation shows, so local mail has been read.
    await expect(
      waitingOnYou.locator(`[data-today-thread="${other.threadId}"]`),
    ).toBeVisible({ timeout: 90_000 });
    await expect(row).toHaveCount(0);

    // Once Needs reply has its own conversations, the group steps aside.
    cueHasRead = true;
    const { needsReply } = await openToday(page);
    await expect(needsReply).toBeVisible();
    await expect(waitingOnYou).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await seeded.remove();
    await other.remove();
  }
});

test("Didn't reach someone: a bounce shows on Today named for what was sent, opens its conversation and stays dismissed", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const run = Date.now();
  const subject = `Quarterly plan ${run}`;
  // A mail server's own address answers in the sent conversation. Its
  // wording is no part of how it is found.
  const otherSubject = `Lunch order ${run}`;
  const bounceFrom = isMicrosoftPlaywright()
    ? { name: "Microsoft Outlook", address: "postmaster@outlook.com" }
    : {
        name: "Mail Delivery Subsystem",
        address: "MAILER-DAEMON@googlemail.com",
      };
  const seeded = await seedMailFromContact(page, subject, {
    from: bounceFrom,
    subject: `Undeliverable: ${subject}`,
  });
  const other = await seedMailFromContact(page, otherSubject, {
    from: bounceFrom,
    subject: `Undeliverable: ${otherSubject}`,
  });
  const cards = page.getByRole("list", { name: "Didn't reach someone" });
  const card = cards.getByRole("listitem").filter({ hasText: subject });
  try {
    const emailAccountId = await getEmailAccountId(page);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => {
        localStorage.setItem("theme", value);
      }, theme);
      await page.goto(`/${emailAccountId}/home`, {
        waitUntil: "domcontentloaded",
      });
      await expect(card).toBeVisible({ timeout: 120_000 });
      await expect(card).toContainText("Didn't reach someone");
      // Named for what the user sent, not the bounce's own subject.
      await expect(card).not.toContainText("Undeliverable");
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await expect(card).toBeVisible();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-didnt-send-${theme}-${size.width}`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    }

    // Open goes to the bounce's conversation, which comes back to Today.
    await card.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(/[?&]from=today/);
    await expect(
      page.getByRole("heading", { name: new RegExp(String(run)) }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(page).toHaveURL(/\/home(\?|$)/);

    // Dismissed stays dismissed in this browser.
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    // The other bounce shows, so local mail has been read.
    await expect(
      cards.getByRole("listitem").filter({ hasText: otherSubject }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(card).toHaveCount(0);
  } finally {
    await seeded.remove();
    await other.remove();
  }
});

test("a new mailbox shows Waiting on you from local mail before Today answers, and it stays put", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const seeded = await seedMailFromContact(page, `Ski trip ${Date.now()}`);
  // A new mailbox: Cue hasn't read it, and Today's answer is held, as Gmail
  // can take seconds to give it during a first sync.
  await page.route(
    (url) => url.pathname === "/api/user/home/cue",
    (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids");
      return route.fulfill({
        json: {
          accounts: (ids ?? "")
            .split(",")
            .map((id) => ({ id, hasReadMail: false })),
        },
      });
    },
  );
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    // Today's own answer only, not its other routes.
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      await released;
      // Released as the test ends, the page may already be gone.
      const response = await route.fetch().catch(() => null);
      if (!response) {
        await route.abort();
        return;
      }
      const home = await response.json();
      home.cue = { aiAccess: true, replyTracking: true, hasReadMail: false };
      home.needsYou = [];
      await route.fulfill({ response, json: home });
    },
  );
  const waitingOnYou = page.getByRole("listbox", {
    name: "Waiting on you",
    exact: true,
  });
  const row = waitingOnYou.locator(`[data-today-thread="${seeded.threadId}"]`);
  try {
    const emailAccountId = await getEmailAccountId(page);
    await page.goto(`/${emailAccountId}/home`, {
      waitUntil: "domcontentloaded",
    });
    await expect(row).toBeVisible({ timeout: 90_000 });
    const status = page.getByRole("main").getByRole("status");
    // Cue's notice comes with the answer, which hasn't arrived.
    await expect(status).toHaveCount(0);
    // The row's wrapper has no box of its own; its option is what shows.
    const option = row.getByRole("option").first();
    const before = await option.boundingBox();
    expect(before).not.toBeNull();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "today-waiting-on-you-before-answer",
    );

    release();
    await expect(status).toContainText("Cue is reading your recent mail.", {
      timeout: 60_000,
    });
    await expect(row).toBeVisible();
    // The answer's notice lands below the group, so the row doesn't move.
    expect((await option.boundingBox())?.y).toBeCloseTo(before?.y ?? -1, 0);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "today-waiting-on-you-after-answer",
    );
  } finally {
    // Today refreshes while it loads; one may still be in the route, so it
    // is let through and finishes before the test does.
    release();
    await page.unrouteAll({ behavior: "wait" });
    await seeded.remove();
  }
});

test("replies to a conversation from Today in the reader", async ({ page }) => {
  await openToday(page);
  const row = todayRow(page, REPLY_THREAD);
  await row.getByRole("option").hover();
  await row.getByRole("button", { name: "Reply to conversation" }).click();

  await expect(page).toHaveURL(/[?&]from=today/);
  await expect(
    page.getByRole("heading", { name: REPLY_SUBJECT }),
  ).toBeVisible();
  const editor = page.locator(
    '[data-testid="thread-reader"] [data-email-editor-content]',
  );
  await expect(editor).toBeFocused();
  await page.keyboard.type("Thanks, replying from Today.");
  await expect(editor).toContainText("Thanks, replying from Today.");
  // The reply starts once; the address no longer asks for one.
  await expect(page).not.toHaveURL(/[?&]reply=1/);

  // Leaving the conversation goes back to Today.
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL(/\/home(\?|$)/);
});

test("nudges a conversation you're waiting on, addressed to the people you last wrote to", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const sent = await seedSentConversation(page, `Nudge me ${Date.now()}`);
  try {
    await seedAwaiting(emailAccountId, sent.threadId);
    await openToday(page);
    const row = page
      .getByRole("listbox", { name: "Waiting on" })
      .locator(`[data-today-thread="${sent.threadId}"]`);
    await row.getByRole("option").hover();
    const nudge = row.getByRole("button", {
      name: "Nudge: follow up on conversation",
    });
    await expect(nudge).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Reply to conversation" }),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "today-nudge-row");
    await nudge.click();

    await expect(page).toHaveURL(/[?&]from=today/);
    const editor = page.locator(
      '[data-testid="thread-reader"] [data-email-editor-content]',
    );
    await expect(editor).toBeFocused({ timeout: 60_000 });
    await expect(editor).toHaveText(/^\s*$/);
    await expect(page).not.toHaveURL(/[?&]reply=1/);
    await capturePlaywrightCheckpoint(page, testInfo, "today-nudge-composer");

    // To the people on the user's own last message, not back to the user.
    const reader = page.locator('[data-testid="thread-reader"]');
    await reader.getByRole("button", { name: /^Reply to / }).click();
    for (const chip of [
      /^Remove .*kai@example\.com/,
      /^Remove .*lin@example\.com/,
    ])
      await expect(reader.getByRole("button", { name: chip })).toBeVisible();

    // Shift+N on the focused row does the same.
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(page).toHaveURL(/\/home(\?|$)/);
    await row.getByRole("option").focus();
    await page.keyboard.press("Shift+N");
    await expect(page).toHaveURL(/[?&]from=today/);
    await expect(editor).toBeFocused({ timeout: 60_000 });
  } finally {
    await sent.remove();
  }
});

test("a reply sent from Outlook clears the conversation from Needs reply", async ({
  page,
}, testInfo) => {
  test.skip(
    !isMicrosoftPlaywright(),
    "Proves Outlook's sent-mail webhook; Gmail's history path has its own coverage.",
  );
  const { emailAccountId, needsReply } = await openToday(page);
  await expect(todayRow(page, REPLY_THREAD).getByRole("option")).toBeVisible();

  const account = await readOutlookAccount(emailAccountId);
  const cleanups: Array<() => Promise<unknown>> = [];
  try {
    cleanups.push(await enableReplyTracking(emailAccountId, account));
    await registerLlmReply({
      match: "determine the current status of this thread",
      object: {
        status: "AWAITING_REPLY",
        rationale: "The user replied and is waiting for an answer.",
      },
    });

    // Sent in Outlook itself, so only Graph's notification tells Cue.
    const comment = `Replied in Outlook ${Date.now()}`;
    const sentMessageId = await replyInOutlook(page, account.accessToken, {
      messageId: "msg_playwright_1",
      threadId: REPLY_THREAD,
      comment,
    });
    cleanups.push(() =>
      page.request.delete(
        `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${sentMessageId}`,
        { headers: { Authorization: `Bearer ${account.accessToken}` } },
      ),
    );
    const webhook = await page.request.post("/api/outlook/webhook", {
      data: {
        value: [
          {
            subscriptionId: TODAY_SUBSCRIPTION_ID,
            clientState:
              process.env.MICROSOFT_WEBHOOK_CLIENT_STATE ??
              "playwright-microsoft-webhook",
            changeType: "created",
            resourceData: { id: sentMessageId },
          },
        ],
      },
    });
    expect(webhook.ok(), await webhook.text()).toBe(true);

    await expect
      .poll(() => openNeedsReplyTrackers(emailAccountId, REPLY_THREAD), {
        timeout: 60_000,
      })
      .toBe(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(needsReply).toBeVisible({ timeout: 60_000 });
    // The reply moved it on to waiting for the other side's answer.
    await expect(
      needsReply.locator(`[data-today-thread="${REPLY_THREAD}"]`),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("listbox", { name: "Waiting on" })
        .locator(`[data-today-thread="${REPLY_THREAD}"]`),
    ).toHaveCount(1);
    await expect(
      needsReply.locator(`[data-today-thread="${ARCHIVE_THREAD}"]`),
    ).toHaveCount(1);
    await capturePlaywrightCheckpoint(page, testInfo, "today-outlook-replied");
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("Today's rows match the inbox in both themes and on phones", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    const { needsReply } = await openToday(page);
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await expect(needsReply.getByText(REPLY_SUBJECT)).toBeVisible();
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("Today says what needs you in one place: busy, all clear, and new", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  // The real answer, reshaped into each state, so counts and calendar stay real.
  let state: "busy" | "clear" | "new" = "busy";
  await page.route(
    // Today's own answer only, not its other routes.
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      const response = await route.fetch().catch(() => null);
      if (!response) {
        await route.abort();
        return;
      }
      const home = await response.json();
      // Cue is checking (the emulated account has no AI plan); only "new" hasn't read mail yet.
      home.cue = {
        aiAccess: true,
        replyTracking: true,
        hasReadMail: state !== "new",
      };
      if (state !== "busy") home.needsYou = [];
      await route.fulfill({ response, json: home });
    },
  );
  const main = page.getByRole("main");

  try {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => {
        localStorage.setItem("theme", value);
      }, theme);
      for (const next of ["busy", "clear", "new"] as const) {
        state = next;
        const emailAccountId = await getEmailAccountId(page);
        await page.goto(`/${emailAccountId}/home`, {
          waitUntil: "domcontentloaded",
        });
        const status = main.getByRole("status");
        if (next === "busy") {
          await expect(status).toHaveText(/^\d+\+? needs? a reply/, {
            timeout: 60_000,
          });
          await expect(
            page.getByRole("listbox", { name: "Needs reply" }),
          ).toBeVisible();
        } else if (next === "clear") {
          await expect(status).toContainText("All clear.", { timeout: 60_000 });
          await expect(status).toContainText("Nothing needs a reply.");
          await expect(
            page.getByRole("listbox", { name: "Needs reply" }),
          ).toHaveCount(0);
        } else {
          await expect(status).toContainText(
            "Cue is reading your recent mail.",
            {
              timeout: 60_000,
            },
          );
          await expect(status).toContainText(
            "What needs a reply will appear here.",
          );
          await expect(page.getByText("All clear.")).toHaveCount(0);
        }
        // One line carries the state; empty lanes don't each say so.
        await expect(status).toHaveCount(1);
        await expect(page.getByText(/Nothing here|caught up/)).toHaveCount(0);
        for (const size of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(size);
          const scrollWidth = await page.evaluate(
            () => document.documentElement.scrollWidth,
          );
          expect(scrollWidth).toBeLessThanOrEqual(size.width);
          await capturePlaywrightCheckpoint(
            page,
            testInfo,
            `today-${next}-${theme}-${size.width}`,
          );
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }
  } finally {
    // Today refreshes while it loads; one may still be in the route.
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("While you were away says what Cue did since the last visit, links each count to History, and dismisses", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  await seedAwayWork(emailAccountId);
  try {
    await page.goto(`/${emailAccountId}/home`, {
      waitUntil: "domcontentloaded",
    });
    const card = page.getByRole("region", { name: "While you were away" });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(
      /Since [^,]+, Cue sorted 1 email, archived 1 and drafted 1 reply\./,
    );
    // The link carries the window it counted, and Cue's own runs only.
    const href = await card
      .getByRole("link", { name: "archived 1" })
      .getAttribute("href");
    const linked = new URL(href ?? "", "http://localhost");
    expect(linked.pathname).toBe(`/${emailAccountId}/automation`);
    expect(Object.fromEntries(linked.searchParams)).toMatchObject({
      tab: "history",
      action: "archived",
      automated: "1",
    });
    expect(linked.searchParams.get("since")).toBeTruthy();
    expect(linked.searchParams.get("until")).toBeTruthy();

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-away-${theme}-${size.width}`,
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });

    await card.getByRole("link", { name: "archived 1" }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname.endsWith("/automation") &&
        url.searchParams.get("action") === "archived",
    );
    await expect(
      page.getByRole("button", { name: "Archived", exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText("Showing what Cue did while you were away."),
    ).toBeVisible();
    await expect(
      page.getByText(AWAY_RULE_NAME, { exact: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Show all history" }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("since"));

    // Dismissed, it stays hidden on the next load, until the next visit.
    await page.goto(`/${emailAccountId}/home`, {
      waitUntil: "domcontentloaded",
    });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(() => readPreviousVisit(emailAccountId), { timeout: 15_000 })
      .toBeNull();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("listbox", { name: "Needs reply" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(0);
  } finally {
    await clearAwayWork(emailAccountId);
  }
});

test("Drafts you left open lists a draft left over an hour ago and opens it in the composer", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  // The fixtures' "Seeded Draft Message" was last saved long ago. A draft
  // saved just now is still being written, so it isn't listed.
  const fresh = await seedFreshDraft(page, `Still writing ${Date.now()}`);
  try {
    const emailAccountId = await getEmailAccountId(page);
    await page.goto(`/${emailAccountId}/home`, {
      waitUntil: "domcontentloaded",
    });
    const list = page.getByRole("list", { name: "Drafts you left open" });
    const row = list.getByRole("link").filter({
      hasText: "Seeded Draft Message",
    });
    await expect(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toContainText("Jordan Example");
    await expect(list).not.toContainText(fresh.subject);
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await row.scrollIntoViewIfNeeded();
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(size.width);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-drafts-left-open-${size.width}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await row.click();
    await expect(page).toHaveURL(/thr_playwright_draft.*[?&]from=today/);
    await expect(
      page.getByRole("textbox", { name: "Email message" }),
    ).toContainText("This unsent draft is visible in the Drafts view.", {
      timeout: 60_000,
    });
  } finally {
    await fresh.remove();
  }
});

test("Before your meeting stays inside a phone-width Today in both themes", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  // News comes from a search provider the emulated app has no key for.
  await page.route("**/api/user/meeting-news*", (route) =>
    route.fulfill({ json: { meetings: [LONG_MEETING_NEWS] } }),
  );
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await openToday(page);
    const card = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Before your meeting" }),
    });
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY),
      ).toBeLessThanOrEqual(size.width);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-meeting-news-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

const LONG_MEETING_NEWS = {
  eventId: "playwright-meeting-news",
  title: "Quarterly partnership review with the regional operations leadership",
  startTime: new Date(Date.now() + 86_400_000).toISOString(),
  organization: "Northwind Traders International Holdings",
  news: [
    {
      title:
        "Northwind Traders International Holdings announces a sweeping reorganization of its European logistics division",
      url: "https://news.example.com/northwind-reorganization",
      domain: "news.international-business-reporting-network.example.com",
      publishedDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
      title: "Northwind-Traders-International-Holdings-Q3-earnings-call-recap",
      url: "https://markets.example.com/northwind-q3",
      domain: "markets.example.com",
    },
  ],
};

async function openToday(page: Page) {
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
  return { emailAccountId, needsReply };
}

function todayRow(page: Page, threadId: string) {
  return page.locator(`[data-today-thread="${threadId}"]`);
}

const KAI_ADDRESS = "kai@example.com";
const LIN_ADDRESS = "lin@example.com";

/** A tracker saying the user is waiting on the conversation's other side. */
async function seedAwaiting(emailAccountId: string, threadId: string) {
  await withClient((client) =>
    client.query(
      `INSERT INTO "ThreadTracker" ("id", "updatedAt", "sentAt", "threadId", "messageId", "type", "emailAccountId")
       VALUES ($1, now(), now(), $2, $1, 'AWAITING', $3)
       ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET "resolved" = false`,
      [`${TRACKER_PREFIX}awaiting-${threadId}`, threadId, emailAccountId],
    ),
  );
}

/**
 * A conversation that is only the user's own message to Kai, copying Lin,
 * and what takes it out again.
 */
async function seedSentConversation(page: Page, subject: string) {
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const draft = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "Any thoughts on the draft?" },
        toRecipients: [
          { emailAddress: { address: KAI_ADDRESS, name: "Kai Example" } },
        ],
        ccRecipients: [
          { emailAddress: { address: LIN_ADDRESS, name: "Lin Example" } },
        ],
      },
    });
    expect(draft.ok(), await draft.text()).toBe(true);
    const draftId = ((await draft.json()) as { id: string }).id;
    const moved = await page.request.post(`${base}/messages/${draftId}/move`, {
      headers,
      data: { destinationId: "sentitems" },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const message = (await moved.json()) as {
      id: string;
      conversationId: string;
    };
    return {
      threadId: message.conversationId,
      remove: async () => {
        await page.request.post(
          `${base}/messages/${message.id}/permanentDelete`,
          { headers },
        );
      },
    };
  }

  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const inserted = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      from: email,
      to: `Kai Example <${KAI_ADDRESS}>`,
      cc: `Lin Example <${LIN_ADDRESS}>`,
      subject,
      body_text: "Any thoughts on the draft?",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - 3_600_000),
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string; threadId: string };
  return {
    threadId: message.threadId,
    remove: async () => {
      await page.request.delete(`${base}/messages/${message.id}`, { headers });
    },
  };
}

async function seedNeedsReply(emailAccountId: string, threadIds: string[]) {
  await withClient(async (client) => {
    for (const threadId of threadIds) {
      await client.query(
        `INSERT INTO "ThreadTracker" ("id", "updatedAt", "sentAt", "threadId", "messageId", "type", "emailAccountId")
         VALUES ($1, now(), now(), $2, $1, 'NEEDS_REPLY', $3)
         ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET "resolved" = false`,
        [`${TRACKER_PREFIX}${threadId}`, threadId, emailAccountId],
      );
    }
  });
}

/**
 * An unread newsletter in the inbox, filed under the Newsletter label (an
 * Outlook category) as Cue's rule would unless `labelled` is false, and what
 * takes it out again.
 */
async function seedNewsletter(
  page: Page,
  subject: string,
  { labelled = true }: { labelled?: boolean } = {},
) {
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    if (labelled) {
      const category = await page.request.post(
        `${base}/outlook/masterCategories`,
        { headers, data: { displayName: "Newsletter" } },
      );
      // Already there from an earlier run is as good.
      expect(category.ok() || category.status() === 409).toBe(true);
    }
    const draft = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "Three essays on slow travel." },
        toRecipients: [{ emailAddress: { address: email } }],
      },
    });
    expect(draft.ok(), await draft.text()).toBe(true);
    const draftId = ((await draft.json()) as { id: string }).id;
    const patched = await page.request.patch(`${base}/messages/${draftId}`, {
      headers,
      data: {
        from: {
          emailAddress: {
            address: "hello@fieldnotes.example",
            name: "Field Notes",
          },
        },
        categories: labelled ? ["Newsletter"] : [],
        isRead: false,
      },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const moved = await page.request.post(`${base}/messages/${draftId}/move`, {
      headers,
      data: { destinationId: "inbox" },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const message = (await moved.json()) as {
      id: string;
      conversationId: string;
      internetMessageId?: string;
    };
    const isThisMessage = (candidate: {
      internetMessageId?: string;
      subject?: string;
    }) =>
      message.internetMessageId
        ? candidate.internetMessageId === message.internetMessageId
        : candidate.subject === subject;
    // Found by its message identity in the folder itself: archiving moves it,
    // which in Graph gives it a new id, and a deleted message is in neither.
    const locate = async () => {
      for (const folder of ["inbox", "archive"] as const) {
        const listed = await page.request.get(
          `${base}/mailFolders/${folder}/messages?$top=500`,
          { headers },
        );
        expect(listed.ok(), await listed.text()).toBe(true);
        const { value } = (await listed.json()) as {
          value: { id: string; internetMessageId?: string; subject?: string }[];
        };
        const found = value.find(isThisMessage);
        if (found) return { folder, id: found.id };
      }
      return null;
    };
    return {
      threadId: message.conversationId,
      messageId: message.id,
      folderOf: async (): Promise<NewsletterFolder> =>
        (await locate())?.folder ?? "missing",
      remove: async () => {
        const current = await locate();
        await page.request.post(
          `${base}/messages/${current?.id ?? message.id}/permanentDelete`,
          { headers },
        );
      },
    };
  }

  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const labels = await page.request.get(`${base}/labels`, { headers });
  expect(labels.ok(), await labels.text()).toBe(true);
  const existing = (
    (await labels.json()) as { labels: { id: string; name: string }[] }
  ).labels.find((label) => label.name === "Newsletter");
  let labelId = existing?.id;
  if (labelled && !labelId) {
    const created = await page.request.post(`${base}/labels`, {
      headers,
      data: { name: "Newsletter" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    labelId = ((await created.json()) as { id: string }).id;
  }
  const inserted = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      from: "Field Notes <hello@fieldnotes.example>",
      to: email,
      subject,
      body_text: "Three essays on slow travel.",
      labelIds: ["INBOX", "UNREAD", ...(labelled && labelId ? [labelId] : [])],
      internalDate: String(Date.now()),
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string; threadId: string };
  return {
    threadId: message.threadId,
    messageId: message.id,
    folderOf: async (): Promise<NewsletterFolder> => {
      const current = await page.request.get(`${base}/messages/${message.id}`, {
        headers,
      });
      if (current.status() === 404) return "missing";
      expect(current.ok(), await current.text()).toBe(true);
      const { labelIds = [] } = (await current.json()) as {
        labelIds?: string[];
      };
      if (labelIds.includes("TRASH") || labelIds.includes("SPAM"))
        return "missing";
      return labelIds.includes("INBOX") ? "inbox" : "archive";
    },
    remove: () =>
      page.request.delete(`${base}/messages/${message.id}`, { headers }),
  };
}

async function expectEngineMutation(
  page: Page,
  emailAccountId: string,
  kind: string,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind,
          threadId: ARCHIVE_THREAD,
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}

type OutlookAccount = {
  accessToken: string;
  premiumId: string | null;
  watchEmailsSubscriptionId: string | null;
};

async function readOutlookAccount(
  emailAccountId: string,
): Promise<OutlookAccount> {
  return withClient(async (client) => {
    const result = await client.query<OutlookAccount>(
      `SELECT account.access_token AS "accessToken", app_user."premiumId",
         email."watchEmailsSubscriptionId"
       FROM "EmailAccount" email JOIN "Account" account ON account.id = email."accountId"
       JOIN "User" app_user ON app_user.id = email."userId"
       WHERE email.id = $1`,
      [emailAccountId],
    );
    if (!result.rows[0]?.accessToken)
      throw new Error("Missing emulator account");
    return result.rows[0];
  });
}

// Graph notifications are processed for premium accounts with a subscription
// and outbound replies only when a conversation status rule is on. Returns
// what puts the account back.
async function enableReplyTracking(
  emailAccountId: string,
  account: OutlookAccount,
) {
  const premiumId = `${TODAY_SUBSCRIPTION_ID}-premium`;
  const ruleId = `${TODAY_SUBSCRIPTION_ID}-awaiting`;
  const existingRule = await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Premium"
         (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[],
         'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [premiumId],
    );
    await client.query(
      `UPDATE "User" SET "premiumId" = $2
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId, premiumId],
    );
    await client.query(
      `UPDATE "EmailAccount" SET "watchEmailsSubscriptionId" = $2 WHERE id = $1`,
      [emailAccountId, TODAY_SUBSCRIPTION_ID],
    );
    const existing = await client.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'AWAITING_REPLY'`,
      [emailAccountId],
    );
    if (existing.rows[0]) {
      await client.query(`UPDATE "Rule" SET enabled = true WHERE id = $1`, [
        existing.rows[0].id,
      ]);
      return existing.rows[0];
    }
    await client.query(
      `INSERT INTO "Rule" (id, name, enabled, "systemType", "emailAccountId", "createdAt", "updatedAt")
       VALUES ($1, 'Playwright awaiting reply', true, 'AWAITING_REPLY', $2,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ruleId, emailAccountId],
    );
    return null;
  });

  return () =>
    withClient(async (client) => {
      await client.query(
        `DELETE FROM "ThreadTracker" WHERE "emailAccountId" = $1 AND "threadId" = $2
         AND "messageId" NOT LIKE $3`,
        [emailAccountId, REPLY_THREAD, `${TRACKER_PREFIX}%`],
      );
      if (existingRule)
        await client.query(`UPDATE "Rule" SET enabled = $2 WHERE id = $1`, [
          existingRule.id,
          existingRule.enabled,
        ]);
      else await client.query(`DELETE FROM "Rule" WHERE id = $1`, [ruleId]);
      await client.query(
        `UPDATE "EmailAccount" SET "watchEmailsSubscriptionId" = $2 WHERE id = $1`,
        [emailAccountId, account.watchEmailsSubscriptionId],
      );
      await client.query(
        `UPDATE "User" SET "premiumId" = $2
         WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
        [emailAccountId, account.premiumId],
      );
      await client.query(`DELETE FROM "Premium" WHERE id = $1`, [premiumId]);
    });
}

async function registerLlmReply(reply: { match: string; object: unknown }) {
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

// Replies through Graph, as Outlook would, and returns the sent message's id.
async function replyInOutlook(
  page: Page,
  accessToken: string,
  {
    messageId,
    threadId,
    comment,
  }: { messageId: string; threadId: string; comment: string },
) {
  const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const reply = await page.request.post(`${base}/messages/${messageId}/reply`, {
    headers,
    data: { comment },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
  const sent = await page.request.get(
    `${base}/mailFolders/sentitems/messages?$top=50`,
    { headers },
  );
  expect(sent.ok(), await sent.text()).toBe(true);
  const { value } = (await sent.json()) as {
    value: Array<{ id: string; conversationId: string; bodyPreview: string }>;
  };
  const message = value.find(
    (item) =>
      item.conversationId === threadId && item.bodyPreview.includes(comment),
  );
  if (!message) throw new Error("The Outlook reply is not in Sent Items");
  return message.id;
}

async function openNeedsReplyTrackers(
  emailAccountId: string,
  threadId: string,
) {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM "ThreadTracker" WHERE "emailAccountId" = $1 AND "threadId" = $2
       AND type = 'NEEDS_REPLY' AND resolved = false`,
      [emailAccountId, threadId],
    );
    return result.rowCount ?? 0;
  });
}

/** Runs every cleanup step in turn, then throws the first failure, if any. */
async function runEach(steps: (() => unknown)[]) {
  let failure: { error: unknown } | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/**
 * Takes the Newsletter label (an Outlook category) off the account, and
 * returns what puts it back, so later tests find the account as it was.
 */
async function removeNewsletterLabel(page: Page) {
  const headers = {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
  };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me/outlook/masterCategories`;
    const listed = await page.request.get(base, { headers });
    expect(listed.ok(), await listed.text()).toBe(true);
    const { value } = (await listed.json()) as {
      value: { id: string; displayName: string }[];
    };
    const removed = value.filter(
      (candidate) => candidate.displayName === "Newsletter",
    );
    for (const category of removed) {
      const deleted = await page.request.delete(`${base}/${category.id}`, {
        headers,
      });
      expect(deleted.ok(), await deleted.text()).toBe(true);
    }
    return async () => {
      if (!removed.length) return;
      await page.request.post(base, {
        headers,
        data: { displayName: "Newsletter" },
      });
    };
  }
  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/labels`;
  const listed = await page.request.get(base, { headers });
  expect(listed.ok(), await listed.text()).toBe(true);
  const { labels } = (await listed.json()) as {
    labels: { id: string; name: string }[];
  };
  const removed = labels.filter((candidate) => candidate.name === "Newsletter");
  for (const label of removed) {
    const deleted = await page.request.delete(`${base}/${label.id}`, {
      headers,
    });
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
  return async () => {
    if (!removed.length) return;
    await page.request.post(base, {
      headers,
      data: { name: "Newsletter" },
    });
  };
}

/**
 * What Cue's Newsletter rule records when it sorts a message without
 * labelling the mailbox: an applied run of that rule. Returns the cleanup.
 */
async function sortAsNewsletter(
  emailAccountId: string,
  { threadId, messageId }: { threadId: string; messageId: string },
) {
  const runId = `${NEWSLETTER_RUN_PREFIX}${messageId}`;
  return withClient(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'NEWSLETTER'`,
      [emailAccountId],
    );
    const ruleId = existing.rows[0]?.id ?? NEWSLETTER_RULE_ID;
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO "Rule"
          (id, name, enabled, automate, "runOnThreads", "systemType",
           "emailAccountId", "createdAt", "updatedAt")
         VALUES ($1, 'Today spec Newsletter', true, true, false, 'NEWSLETTER',
                 $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        [NEWSLETTER_RULE_ID, emailAccountId],
      );
    }
    await client.query(
      `INSERT INTO "ExecutedRule"
        (id, "createdAt", "updatedAt", "threadId", "messageId", status,
         automated, "ruleId", "emailAccountId")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $2, $3, 'APPLIED',
               true, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [runId, threadId, messageId, ruleId, emailAccountId],
    );
    return () =>
      withClient(async (cleanup) => {
        await cleanup.query(`DELETE FROM "ExecutedRule" WHERE id = $1`, [
          runId,
        ]);
        await cleanup.query(`DELETE FROM "Rule" WHERE id = $1`, [
          NEWSLETTER_RULE_ID,
        ]);
      });
  });
}

/** Where a seeded newsletter is: "missing" when deleted, trashed or gone. */
type NewsletterFolder = "inbox" | "archive" | "missing";

const AWAY_RULE_PREFIX = "playwright-away-";
const AWAY_RULE_NAME = "Playwright away rule";

/**
 * A return just now after twenty hours away, during which Cue sorted one
 * email, archived one and drafted a reply to one. The last login is now, so
 * this load doesn't count as another return.
 */
async function seedAwayWork(emailAccountId: string) {
  await clearAwayWork(emailAccountId);
  await withClient(async (client) => {
    await client.query(
      `UPDATE "User" SET "lastLogin" = now(), "visitReturnedAt" = now(),
         "previousVisitAt" = now() - interval '20 hours'
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId],
    );
    const ruleId = `${AWAY_RULE_PREFIX}rule`;
    await client.query(
      `INSERT INTO "Rule" (id, "updatedAt", name, "emailAccountId")
       VALUES ($1, now(), $2, $3)`,
      [ruleId, AWAY_RULE_NAME, emailAccountId],
    );
    for (const type of ["LABEL", "ARCHIVE", "DRAFT_EMAIL"]) {
      const id = `${AWAY_RULE_PREFIX}${type}`;
      await client.query(
        `INSERT INTO "ExecutedRule" (id, "createdAt", "updatedAt", "threadId", "messageId", status, automated, "emailAccountId", "ruleId")
         VALUES ($1, now() - interval '2 hours', now(), $1, $1, 'APPLIED', true, $2, $3)`,
        [id, emailAccountId, ruleId],
      );
      await client.query(
        `INSERT INTO "ExecutedAction" (id, "updatedAt", type, "executionStatus", "executedRuleId")
         VALUES ($1, now(), $2::"ActionType", 'SUCCEEDED', $1)`,
        [id, type],
      );
    }
  });
}

async function clearAwayWork(emailAccountId: string) {
  await withClient(async (client) => {
    await client.query(`DELETE FROM "ExecutedRule" WHERE id LIKE $1`, [
      `${AWAY_RULE_PREFIX}%`,
    ]);
    await client.query(`DELETE FROM "Rule" WHERE id LIKE $1`, [
      `${AWAY_RULE_PREFIX}%`,
    ]);
    await client.query(
      `UPDATE "User" SET "previousVisitAt" = NULL, "visitReturnedAt" = NULL
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId],
    );
  });
}

async function readPreviousVisit(emailAccountId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ previousVisitAt: Date | null }>(
      `SELECT u."previousVisitAt" FROM "User" u
       JOIN "EmailAccount" e ON e."userId" = u.id WHERE e.id = $1`,
      [emailAccountId],
    );
    return result.rows[0]?.previousVisitAt ?? null;
  });
}

/** A new email's draft saved now, in the provider, and what removes it. */
async function seedFreshDraft(page: Page, subject: string) {
  const token = await readProviderAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const created = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "Half a thought" },
        toRecipients: [{ emailAddress: { address: KAI_ADDRESS } }],
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    return {
      subject,
      remove: async () => {
        await page.request.post(`${base}/messages/${id}/permanentDelete`, {
          headers,
        });
      },
    };
  }
  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const created = await page.request.post(`${base}/drafts`, {
    headers,
    data: {
      message: {
        to: KAI_ADDRESS,
        subject,
        body_text: "Half a thought",
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  return {
    subject,
    remove: async () => {
      await page.request.delete(`${base}/drafts/${id}`, { headers });
    },
  };
}
