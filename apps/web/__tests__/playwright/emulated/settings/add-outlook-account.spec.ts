import { expect } from "@playwright/test";
import { Client } from "pg";
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
    await page.goto("/accounts", { waitUntil: "domcontentloaded" });
    // A production build only follows https sign-in links, and the emulator
    // serves http, so the test follows the link the button was given.
    let authUrl: string | undefined;
    await page.route("**/api/outlook/linking/auth-url**", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { url: string };
      authUrl = body.url;
      await route.fulfill({ response, json: { url: "/accounts" } });
    });
    await page.getByRole("button", { name: "Add Microsoft" }).click();
    await expect.poll(() => authUrl).toBeTruthy();
    // The app's own navigation back to /accounts can interrupt the first try.
    await expect(async () => {
      await page.goto(authUrl!);
    }).toPass({ timeout: 30_000 });

    await expect(page).toHaveURL(/\/oauth2\/v2\.0\/authorize(?:\?.*)?$/);
    await page.getByRole("button", { name: LINKED_OUTLOOK_EMAIL }).click();

    await expect(page).toHaveURL(
      /\/accounts\?success=account_created_and_linked/,
      {
        timeout: 60_000,
      },
    );
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
    await deleteLinkedOutlookAccount();
  }
});

// The Google account is shared by every spec in the run.
async function deleteLinkedOutlookAccount() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM "Account" WHERE id IN
         (SELECT "accountId" FROM "EmailAccount" WHERE email = $1)`,
      [LINKED_OUTLOOK_EMAIL],
    );
  } finally {
    await client.end();
  }
}
