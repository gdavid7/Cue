import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import {
  getCalendarConnectionCount,
  getCalendarTestState,
  openCalendars,
  PLAYWRIGHT_TEST_EMAIL,
  resetCalendarTestState,
  setupCalendarTestState,
} from "./calendar-test-helpers";

test.beforeEach(async () => {
  await setupCalendarTestState();
});

test.afterEach(async () => {
  await resetCalendarTestState();
});

test("changes which Google calendar is used for availability", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openCalendars(page);

  const calendarSummary = page.getByRole("button", {
    name: "1 of 1 calendars selected for availability",
  });
  await expect(calendarSummary).toBeVisible({ timeout: 60_000 });
  await calendarSummary.click();

  const primaryCalendar = calendarSummary
    .locator("..")
    .getByText(PLAYWRIGHT_TEST_EMAIL, { exact: true });
  await expect(primaryCalendar).toBeVisible();
  const calendarCard = primaryCalendar.locator(
    "xpath=ancestor::div[contains(@class, 'group/card')][1]",
  );
  const availabilitySwitch = calendarCard.getByRole("switch");
  await expect(availabilitySwitch).toBeChecked();
  await availabilitySwitch.click();
  await expect
    .poll(() => getCalendarTestState(), { timeout: 120_000 })
    .toMatchObject({ calendarEnabled: false });

  await openCalendars(page);
  await expect(
    page.getByRole("button", {
      name: "0 of 1 calendars selected for availability",
    }),
  ).toBeVisible({ timeout: 120_000 });
});

test("disconnects a calendar after confirming from the options menu", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openCalendars(page);

  const options = page.getByRole("button", { name: "Calendar options" });
  await expect(options).toBeVisible({ timeout: 60_000 });
  await options.click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();

  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();

  // A slow disconnect must still refresh the list once it lands, rather than
  // refetching before the connection is deleted.
  await page.route(
    (url) => url.pathname.endsWith("/calendars"),
    async (route) => {
      if (route.request().headers()["next-action"]) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await route.continue();
    },
  );
  await confirmation.getByRole("button", { name: "Disconnect" }).click();

  await expect(confirmation).toBeHidden();
  await expect
    .poll(() => getCalendarConnectionCount(), { timeout: 60_000 })
    .toBe(0);
  await expect(options).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText("Calendar disconnected")).toBeVisible();
});

test("persists the booking link and scheduling timezone", async ({ page }) => {
  test.setTimeout(360_000);
  await openCalendars(page);

  const bookingLinkInput = page.getByPlaceholder("https://cal.com/your-link");
  await bookingLinkInput.fill("https://cal.com/playwright-test");
  await bookingLinkInput
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(
    page.getByText("Booking link updated", { exact: true }).last(),
  ).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => getCalendarTestState(), { timeout: 120_000 })
    .toMatchObject({ bookingLink: "https://cal.com/playwright-test" });

  // CSS locator: the timezone mismatch dialog hides the page from role queries after reload.
  const timezonePicker = page.locator('button[role="combobox"]', {
    hasText: "GMT",
  });
  await timezonePicker.click();
  await page.getByPlaceholder("Search...").fill("Paris");
  await page.getByRole("option", { name: /^Paris \(GMT/ }).click();
  await timezonePicker
    .locator("xpath=../..")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(
    page.getByText("Timezone updated", { exact: true }).last(),
  ).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => getCalendarTestState(), { timeout: 120_000 })
    .toMatchObject({ timezone: "Europe/Paris" });

  await openCalendars(page);
  await expect(bookingLinkInput).toHaveValue(
    "https://cal.com/playwright-test",
    { timeout: 120_000 },
  );
  await expect(timezonePicker).toHaveText(/^Paris \(GMT/, {
    timeout: 120_000,
  });
});
