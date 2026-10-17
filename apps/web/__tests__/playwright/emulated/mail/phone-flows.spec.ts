import { expect, type Locator } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  clearWorkflowMailboxDrafts,
  conversationWithSubject,
  expectThreadReaderBody,
  openMail,
  readLatestMailMutation,
  UNDO_WINDOW_SEND_TIMEOUT_MS,
  waitForComposeOutboxSend,
} from "./mail-test-helpers";

const PHONE = { width: 390, height: 844 };

// A touchscreen phone, so taps go through touch events and `pointer: coarse`
// styles apply, as they do on an iPhone.
test.use({
  viewport: PHONE,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

test.beforeEach(async ({ page }) => {
  await clearWorkflowMailboxDrafts(page);
});

test("composes and sends a message on a phone", async ({ page }, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const subject = `Playwright Phone Compose ${testInfo.retry}`;

  await page.getByRole("button", { name: /^Compose/ }).tap();
  const dialog = page.getByRole("dialog", { name: "New Message" });
  await expect(dialog).toBeVisible();
  await expectWithinPhone(dialog);
  await dialog
    .getByRole("combobox", { name: "To" })
    .fill("recipient@example.com");
  await dialog.getByPlaceholder("Subject").fill(subject);
  const editor = dialog.getByRole("textbox", { name: "Email message" });
  await editor.tap();
  await editor.pressSequentially("Written on a phone.");
  await expect(editor).toContainText("Written on a phone.");

  const send = dialog.getByRole("button", { exact: true, name: "Send" });
  await expect(send).toBeInViewport({ ratio: 1 });
  await capturePlaywrightCheckpoint(page, testInfo, "phone-compose");
  await send.tap();

  await expect(dialog).toBeHidden();
  await waitForComposeOutboxSend(page, emailAccountId);
});

test("replies to a thread and sends on a phone", async ({ page }, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  await conversationWithSubject(
    page,
    conversations,
    "Reply Workflow Message",
  ).tap();
  const message = page.locator(
    '[data-thread-message-id="msg_playwright_reply"]',
  );
  await expect(message).toBeVisible({ timeout: 60_000 });

  await message.getByRole("button", { name: "Reply", exact: true }).tap();
  const editor = message.getByRole("textbox", { name: "Email message" });
  // The inline composer loads its editor on first use.
  await expect(editor).toBeVisible({ timeout: 60_000 });
  const replyBody = `A reply sent from a phone. ${testInfo.retry}`;
  await editor.tap();
  await editor.pressSequentially(replyBody);
  await expect(editor).toContainText(replyBody);

  const send = message.getByRole("button", { name: "Send", exact: true });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  await capturePlaywrightCheckpoint(page, testInfo, "phone-inline-reply");
  await send.tap();

  await expect(editor).toHaveCount(0);
  await expectThreadReaderBody(page, replyBody);
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId: "thr_playwright_reply",
        }),
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS },
    )
    .toMatchObject({ status: "succeeded" });
});

test("searches and opens a result on a phone", async ({ page }, testInfo) => {
  const { conversations } = await openMail(page);
  const search = page.getByRole("combobox", { name: "Search mail" });
  await search.tap();
  await search.fill("Archive Action");
  await search.press("Enter");

  await expect(page).toHaveURL(/[?&]q=/);
  await expect(
    conversationWithSubject(page, conversations, "Keyboard Navigation Message"),
  ).toHaveCount(0);
  const result = conversationWithSubject(
    page,
    conversations,
    "Archive Action Message",
  );
  await expect(result).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "phone-search-results");
  await result.tap();

  const heading = page.getByRole("heading", { name: "Archive Action Message" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeInViewport();
});

test("reaches the last Settings control on a phone", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  await page.goto(`/${emailAccountId}/mail?settings=open`);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(
    dialog.getByRole("heading", { name: "Email accounts", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expectWithinPhone(dialog);

  // The last group depends on which features are on; its last control is the
  // bottom of the dialog either way.
  const lastControl = dialog
    .locator("section")
    .last()
    .getByRole("button")
    .last();
  await lastControl.scrollIntoViewIfNeeded();
  await expect(lastControl).toBeInViewport({ ratio: 1 });
  await expectWithinPhone(lastControl);
  await capturePlaywrightCheckpoint(page, testInfo, "phone-settings-bottom");
});

async function expectWithinPhone(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected an element on screen");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height + 0.5);
}
