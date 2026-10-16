import { expect } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { openMail } from "./mail-test-helpers";

const LAST_ACCOUNT_COOKIE = "last_email_account_id";

test("stays on the open account when an earlier account is removed elsewhere", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const second = await createSecondEmailAccount(emailAccountId);
  const third = await createSecondEmailAccount(emailAccountId);
  let secondDeleted = false;

  try {
    // Accounts are numbered in the order they were connected.
    await page.goto("/mail/u/2", { waitUntil: "domcontentloaded" });
    const conversations = page.getByRole("listbox", { name: "Conversations" });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    const switcherFor = (email: string) =>
      page.getByRole("button", { name: new RegExp(escapeRegExp(email)) });
    await expect(switcherFor(third.email).first()).toBeVisible({
      timeout: 60_000,
    });
    // The page records the account it opened, which is what a later visit
    // to a position that no longer exists falls back to.
    await expect
      .poll(
        async () =>
          (await page.context().cookies()).find(
            (cookie) => cookie.name === LAST_ACCOUNT_COOKIE,
          )?.value ?? "",
        { timeout: 60_000 },
      )
      .toContain(third.id);

    // Removed on another device: the third account is now position 1.
    await deleteSecondEmailAccount(second.accountId);
    secondDeleted = true;
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/mail\/u\/1(\/|$|\?)/, { timeout: 60_000 });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    await expect(switcherFor(third.email).first()).toBeVisible({
      timeout: 60_000,
    });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "account-removal-routing-same-account",
    );
  } finally {
    if (!secondDeleted) await deleteSecondEmailAccount(second.accountId);
    await deleteSecondEmailAccount(third.accountId);
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
