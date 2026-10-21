import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  openMail,
  openThreadIdFromUrl,
  readLatestMailMutation,
} from "./mail-test-helpers";

const THREAD_ID = "thr_playwright_reader_html";

test("opens a sender's card and goes from it to a past conversation", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await sender.click();
  const card = page.getByTestId("person-card");
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("heading", { name: "Dana Example", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("dana@example.com", { exact: true }),
  ).toBeVisible();
  const recent = card
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Recent conversations" }),
    })
    .getByRole("button");
  // Dana has written about more than the open conversation, which the card
  // leaves out.
  await expect(recent.first()).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-light");

  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-dark");
  await page.emulateMedia({ colorScheme: "light" });

  const subject = (
    await recent.first().locator("span.truncate").first().textContent()
  )?.trim();
  expect(subject).toBeTruthy();
  await recent.first().click();

  await expect(card).toBeHidden();
  await expect.poll(() => openThreadIdFromUrl(page.url())).not.toBe(THREAD_ID);
  await expect(
    page.getByRole("heading", { name: subject, exact: true }).first(),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-opened-past");
});

test("opens the sender's card from the keyboard and keeps focus in it", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await page.keyboard.press("i");
  const card = page.getByTestId("person-card");
  await expect(card).toBeVisible();
  const focusInCard = () =>
    card.evaluate((element) => element.contains(document.activeElement));
  await expect.poll(focusInCard).toBe(true);
  for (let step = 0; step < 12; step++) await page.keyboard.press("Tab");
  expect(await focusInCard()).toBe(true);

  // Mail keys belong to the card while it is open: `e` doesn't archive.
  await page.keyboard.press("e");
  await expect(card).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // The reader stays on the conversation, with focus back on the name, and
  // the `e` pressed in the card queued no archive.
  expect(openThreadIdFromUrl(page.url())).toBe(THREAD_ID);
  await expect(sender).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Reader Html Message", exact: true }),
  ).toBeVisible();
  expect(
    await readLatestMailMutation(page, {
      emailAccountId,
      kind: "archive",
      threadId: THREAD_ID,
    }),
  ).toBeUndefined();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-closed");
});

test("shows the card as a sheet on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await sender.click();
  const sheet = page.getByRole("dialog", { name: "Dana Example" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "New message" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-mobile");

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

async function openThread(page: Page, emailAccountId: string) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${THREAD_ID}`, {
    waitUntil: "domcontentloaded",
  });
  const message = page.locator(
    'li[data-thread-message-id="msg_playwright_reader_html"]',
  );
  await expect(message).toBeVisible({ timeout: 60_000 });
  const sender = message.getByRole("button", {
    name: "Dana Example",
    exact: true,
  });
  await expect(sender).toBeVisible();
  return sender;
}
