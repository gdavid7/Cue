import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

const ACCOUNT_LOOKUP_TIMEOUT_MS = 60_000;
const ACCOUNT_LOOKUP_RETRY_MS = 1000;

type EmailAccount = {
  email: string;
  id: string;
};

type AccountLookupOptions = {
  timeout?: number;
};

export async function getEmailAccount(
  page: Page,
  { timeout = ACCOUNT_LOOKUP_TIMEOUT_MS }: AccountLookupOptions = {},
) {
  let lastError: unknown;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const response = await page.request.get("/api/user/email-accounts");
      if (response.ok()) {
        const { emailAccounts } = (await response.json()) as {
          emailAccounts: EmailAccount[];
        };
        const emailAccount = emailAccounts[0];
        if (emailAccount) return emailAccount;
        lastError = new Error("The setup project created no account");
      } else {
        lastError = new Error(
          `Email accounts request failed with ${response.status()}`,
        );
      }
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(ACCOUNT_LOOKUP_RETRY_MS);
  }

  throw new Error(
    `Could not read the setup email account: ${getErrorMessage(lastError)}`,
  );
}

export async function getEmailAccountId(
  page: Page,
  options?: AccountLookupOptions,
) {
  const emailAccount = await getEmailAccount(page, options);
  return emailAccount.id;
}

/**
 * Links the run's Outlook mailbox to the signed-in Google user through the
 * Microsoft emulator's consent screen, as Accounts' "Add Microsoft" does.
 * Google runs only: they start the second emulator that holds it.
 */
export async function linkOutlookAccount(page: Page, outlookEmail: string) {
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
  await page.unroute("**/api/outlook/linking/auth-url**");

  await expect(page).toHaveURL(/\/oauth2\/v2\.0\/authorize(?:\?.*)?$/);
  await page.getByRole("button", { name: outlookEmail }).click();
  await expect(page).toHaveURL(
    /\/accounts\?success=account_created_and_linked/,
    { timeout: 60_000 },
  );
}

// The Google account is shared by every spec in the run.
export async function deleteLinkedOutlookAccount(outlookEmail: string) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM "Account" WHERE id IN
         (SELECT "accountId" FROM "EmailAccount" WHERE email = $1)`,
      [outlookEmail],
    );
  } finally {
    await client.end();
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
