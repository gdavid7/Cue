import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { readLatestMailMutation, withClient } from "./mail-test-helpers";

// Seeded inbox conversations, put in Today's "Needs reply" lane by a tracker.
const ARCHIVE_THREAD = "thr_playwright_archive";
const REPLY_THREAD = "thr_playwright_1";
const REPLY_SUBJECT = "Playwright Test Message";
const TRACKER_PREFIX = "playwright-today-";

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
