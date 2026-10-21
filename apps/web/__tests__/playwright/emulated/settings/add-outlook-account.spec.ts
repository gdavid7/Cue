import { expect } from "@playwright/test";
import {
  deleteLinkedOutlookAccount,
  linkOutlookAccount,
} from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
const LINKED_OUTLOOK_EMAIL = process.env.PLAYWRIGHT_LINKED_OUTLOOK_EMAIL ?? "";

test.skip(
  isMicrosoftPlaywright(),
  "Google runs start a second, Microsoft emulator for the Outlook mailbox to link.",
);

test("a Google user links an Outlook mailbox and reads its mail", async ({
  page,
}, testInfo) => {
  expect(LINKED_OUTLOOK_EMAIL).not.toBe("");

  try {
    await linkOutlookAccount(page, LINKED_OUTLOOK_EMAIL);
    const outlookAccount = page.getByText(LINKED_OUTLOOK_EMAIL, {
      exact: true,
    });
    await expect(outlookAccount).toBeVisible();
    // Across accounts, the sidebar's Chat, Rules and Meetings rows repeat the email.
    await expect(
      page.getByText(PLAYWRIGHT_TEST_EMAIL, { exact: true }).first(),
    ).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "outlook-linked");

    await outlookAccount.click();
    await expect(
      page.getByRole("listbox", { name: "Conversations" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole("option").filter({ hasText: "Linked Outlook Message" }),
    ).toBeVisible({ timeout: 60_000 });
    await capturePlaywrightCheckpoint(page, testInfo, "outlook-linked-mail");
  } finally {
    await deleteLinkedOutlookAccount(LINKED_OUTLOOK_EMAIL);
  }
});
