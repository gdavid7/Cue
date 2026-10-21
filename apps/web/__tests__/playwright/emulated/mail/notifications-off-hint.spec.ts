import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail, withClient } from "./mail-test-helpers";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// Hint id from NOTIFICATIONS_OFF_HINT_ID.
const HINT_ID = "web-notifications-off";
const HINT_TEXT = "Notifications are off, so new mail won't alert you.";

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await clearHintDismissal();
});

test.afterAll(async () => {
  await clearHintDismissal();
});

test("offers to turn notifications on for someone who passed on the offer", async ({
  page,
}, testInfo) => {
  await stubNotifications(page, { permission: "default", asked: true });
  await openMail(page);

  const hint = page.getByRole("status").filter({ hasText: HINT_TEXT });
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "notifications-off-hint");

  await hint.getByRole("button", { name: "Turn on" }).click();
  await expect(hint).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("cue:web-notifications:mode"),
    ),
  ).toBe("important");
});

test("tells someone whose browser blocks notifications how to allow them", async ({
  page,
}, testInfo) => {
  await stubNotifications(page, { permission: "denied", asked: false });
  await openMail(page);

  const hint = page
    .getByRole("status")
    .filter({ hasText: "allow them for this site in your browser settings" });
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await expect(hint.getByRole("button", { name: "Turn on" })).toHaveCount(0);
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "notifications-off-hint-blocked",
  );
});

test("closing the hint silences it for good", async ({ page }) => {
  await stubNotifications(page, { permission: "default", asked: true });
  await openMail(page);

  const hint = page.getByRole("status").filter({ hasText: HINT_TEXT });
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await hint.getByRole("button", { name: "Dismiss" }).click();
  await expect(hint).toHaveCount(0);
  await expect.poll(isHintDismissed, { timeout: 30_000 }).toBe(true);

  // A new visit is outside the snooze window, so only the saved dismissal
  // keeps it away.
  await page.evaluate(() =>
    window.localStorage.removeItem("cue:web-notifications:off-hint-shown"),
  );
  await openMail(page);
  await page.waitForTimeout(1500);
  await expect(hint).toHaveCount(0);
});

test("stays away when notifications are already on", async ({ page }) => {
  await stubNotifications(page, { permission: "granted", asked: true });
  await openMail(page);
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("status").filter({ hasText: HINT_TEXT }),
  ).toHaveCount(0);
});

test("shows at most once per stretch of days", async ({ page }) => {
  await stubNotifications(page, { permission: "default", asked: true });
  await openMail(page);
  const hint = page.getByRole("status").filter({ hasText: HINT_TEXT });
  await expect(hint).toBeVisible({ timeout: 60_000 });

  await openMail(page);
  await page.waitForTimeout(1500);
  await expect(hint).toHaveCount(0);
});

async function stubNotifications(
  page: Page,
  input: { permission: NotificationPermission; asked: boolean },
) {
  await page.addInitScript((stub) => {
    if (stub.asked)
      window.localStorage.setItem("cue:web-notifications:prompted", "1");
    let permission = stub.permission;
    const StubNotification = {
      get permission() {
        return permission;
      },
      requestPermission() {
        permission = "granted";
        return Promise.resolve(permission);
      },
    };
    Object.defineProperty(window, "Notification", {
      value: StubNotification,
      configurable: true,
      writable: true,
    });
  }, input);
}

async function isHintDismissed() {
  return withClient(async (client) => {
    const result = await client.query<{ has: boolean }>(
      `SELECT $2 = ANY("dismissedHints") AS has FROM "User" WHERE email = $1`,
      [PLAYWRIGHT_TEST_EMAIL, HINT_ID],
    );
    return result.rows[0]?.has ?? false;
  });
}

async function clearHintDismissal() {
  await withClient((client) =>
    client.query(
      `UPDATE "User"
       SET "dismissedHints" = array_remove("dismissedHints", $2)
       WHERE email = $1`,
      [PLAYWRIGHT_TEST_EMAIL, HINT_ID],
    ),
  );
}
