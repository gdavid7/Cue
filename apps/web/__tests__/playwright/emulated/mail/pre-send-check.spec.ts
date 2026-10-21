import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openSettings } from "../settings/settings-test-helpers";
import { clearWorkflowMailboxDrafts, openMail } from "./mail-test-helpers";

const PRE_SEND_CHECK_KEY = "cue.pre-send-check";

test.beforeEach(async ({ page }) => {
  await clearWorkflowMailboxDrafts(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    PRE_SEND_CHECK_KEY,
  );
});

test("asks before sending a message that mentions a missing attachment", async ({
  page,
}, testInfo) => {
  await openMail(page);
  const dialog = await composeMentioningAttachment(
    page,
    `Playwright Pre-send Check ${testInfo.retry}-${Date.now()}`,
  );
  const send = dialog.getByRole("button", { exact: true, name: "Send" });
  await send.click();

  const check = dialog.getByRole("group", { name: "Before you send" });
  await expect(check).toContainText(
    "The message mentions an attachment, but nothing is attached.",
  );
  const sendAnyway = check.getByRole("button", { name: "Send anyway" });
  await expect(sendAnyway).toBeFocused();
  await expect(
    check.getByRole("button", { name: "Attach files" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-check-shown");

  // Escape steps back to the draft without closing the composer.
  await page.keyboard.press("Escape");
  await expect(check).toBeHidden();
  await expect(dialog).toBeVisible();

  await send.click();
  await expect(sendAnyway).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByText("Sending…", { exact: true }),
  ).toBeVisible();
});

test("sends straight away when the check is turned off in Settings", async ({
  page,
}, testInfo) => {
  await openSettings(page);
  const toggle = page.getByRole("switch", { name: "Check before sending" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-check-setting");

  await openMail(page);
  const dialog = await composeMentioningAttachment(
    page,
    `Playwright Pre-send Off ${testInfo.retry}-${Date.now()}`,
  );
  await dialog.getByRole("button", { exact: true, name: "Send" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Before you send" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByText("Sending…", { exact: true }),
  ).toBeVisible();
});

async function composeMentioningAttachment(page: Page, subject: string) {
  await page.getByRole("button", { name: /^Compose/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Message" });
  await dialog
    .getByRole("combobox", { name: "To" })
    .fill("recipient@example.com");
  await dialog.getByPlaceholder("Subject").fill(subject);
  const editor = dialog.locator("[contenteditable='true']");
  await editor.pressSequentially("The signed contract is attached.");
  await expect(editor).toContainText("The signed contract is attached.");
  return dialog;
}
