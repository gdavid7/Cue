import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

// Seeded for both providers: Kai Example, whom the user has written to at
// kai@example.com, writing from an address the user never wrote to.
const FAMILIAR_THREAD = "thr_playwright_familiar_name";
const FAMILIAR_MESSAGE = "msg_playwright_familiar_name";
const NOTICE =
  "Kai Example usually writes from kai@example.com. This message is from kai.example@lookalike.test.";
const ALLOW_STORE = /:sender-notice-allowed:/;

test("says when a familiar name writes from a new address, until it's marked fine", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { emailAccountId } = await openMail(page);
  const message = await openMessage(
    page,
    emailAccountId,
    FAMILIAR_THREAD,
    FAMILIAR_MESSAGE,
  );

  const notice = message.getByTestId("sender-notice");
  // The line waits for this device's contact index to finish its first pass.
  await expect(notice).toContainText(NOTICE, {
    timeout: 90_000,
  });
  await capturePlaywrightCheckpoint(page, testInfo, "sender-notice-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "sender-notice-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Show contact opens the card of the address Kai usually writes from.
  await notice.getByRole("button", { name: "Show contact" }).click();
  const card = page.getByTestId("person-card");
  await expect(card).toBeVisible();
  await expect(
    card.getByText("kai@example.com", { exact: true }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "sender-notice-card");
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();

  await notice.getByRole("button", { name: "It's fine" }).click();
  await expect(notice).toHaveCount(0);

  // The choice is kept on this device across a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = page.locator(
    `li[data-thread-message-id="${FAMILIAR_MESSAGE}"]`,
  );
  await expect(reloaded).toBeVisible({ timeout: 60_000 });
  await expect(reloaded.getByText("A note under a familiar name")).toBeVisible({
    timeout: 60_000,
  });
  await settle(page);
  await expect(reloaded.getByTestId("sender-notice")).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "sender-notice-allowed");

  // And it is that choice hiding the line: forgetting it brings it back.
  await page.evaluate((pattern) => {
    for (const key of Object.keys(window.localStorage))
      if (new RegExp(pattern).test(key)) window.localStorage.removeItem(key);
  }, ALLOW_STORE.source);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page
      .locator(`li[data-thread-message-id="${FAMILIAR_MESSAGE}"]`)
      .getByTestId("sender-notice"),
  ).toBeVisible({ timeout: 90_000 });
});

test("says nothing about a sender at an address they always use", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { emailAccountId } = await openMail(page);
  // The familiar-name line showing first proves the contact index is ready,
  // so its absence below is a real answer.
  const familiar = await openMessage(
    page,
    emailAccountId,
    FAMILIAR_THREAD,
    FAMILIAR_MESSAGE,
  );
  await expect(familiar.getByTestId("sender-notice")).toBeVisible({
    timeout: 90_000,
  });

  const normal = await openMessage(
    page,
    emailAccountId,
    "thr_playwright_reader_html",
    "msg_playwright_reader_html",
  );
  await expect(
    normal.getByText("A rich email body for keyboard navigation."),
  ).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await expect(page.getByTestId("sender-notice")).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "sender-notice-none");
});

async function openMessage(
  page: Page,
  emailAccountId: string,
  threadId: string,
  messageId: string,
) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  const message = page.locator(`li[data-thread-message-id="${messageId}"]`);
  await expect(message).toBeVisible({ timeout: 60_000 });
  return message;
}

// The local lookup answers in milliseconds once the index is ready; give it
// time to land before asserting that nothing showed.
async function settle(page: Page) {
  await page.waitForTimeout(2000);
}
