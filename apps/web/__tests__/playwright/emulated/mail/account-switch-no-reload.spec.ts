import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { openMail } from "./mail-test-helpers";

const LAST_ACCOUNT_COOKIE = "last_email_account_id";

// Remembering the open account used to be a server action, and an action that
// sets a cookie makes Next.js re-render the route, which hard-reloads a page
// the user has already moved on from.
test("remembering the switched-to account does not reload a page being navigated", async ({
  page,
}) => {
  const { emailAccountId } = await openMail(page);
  const second = await createSecondEmailAccount(emailAccountId);

  try {
    await page.goto("/mail/u/1", { waitUntil: "domcontentloaded" });
    const conversations = page.getByRole("listbox", { name: "Conversations" });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    const options = conversations.getByRole("option");
    await expect(options.nth(1)).toBeVisible();
    await options.first().click();

    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    const remembered = async () =>
      (await page.context().cookies()).find(
        (cookie) => cookie.name === LAST_ACCOUNT_COOKIE,
      )?.value ?? "";

    for (const key of ["j", "k", "j", "k"]) await page.keyboard.press(key);
    await expect.poll(remembered, { timeout: 60_000 }).toContain(second.id);
    // A revalidation lands right after the response that set the cookie.
    for (const key of ["j", "k"]) await page.keyboard.press(key);
    await page.waitForTimeout(3000);

    expect(loads).toEqual([]);
  } finally {
    await deleteSecondEmailAccount(second.accountId);
  }
});
