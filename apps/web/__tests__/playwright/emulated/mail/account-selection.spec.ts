import { expect } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { openMail } from "./mail-test-helpers";

test("chooses which accounts appear in All Accounts", async ({
  page,
}, testInfo) => {
  const { emailAccountId, conversations } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  // The account shortcuts, not the "?" on the Keyboard shortcuts row.
  const accountShortcuts = page
    .getByRole("menu")
    .locator("kbd")
    .filter({ hasText: /\d$/ });

  try {
    await page.reload();
    // The frame painted before the mail engine is ready is replaced once it
    // is, which would close a menu opened in it.
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole("button", { name: /playwright-test\+/i })
      .last()
      .click();
    const chooseAccountsMenuItem = page.getByRole("menuitem", {
      name: "Choose accounts",
    });
    await expect(chooseAccountsMenuItem).toBeVisible();

    await page.locator("nextjs-portal").evaluateAll((portals) => {
      for (const portal of portals) portal.remove();
    });
    await capturePlaywrightCheckpoint(page, testInfo, "all-accounts-menu");
    await expect(accountShortcuts).toHaveCount(0);

    await page.addInitScript(() => {
      Object.assign(window, {
        inboxZeroDesktop: { startAuth: async () => {} },
      });
    });
    for (const { userAgent, modifier, checkpoint } of [
      {
        userAgent: "Macintosh",
        modifier: "⌘",
        checkpoint: "account-shortcuts-mac",
      },
      {
        userAgent: "Windows NT 10.0",
        modifier: "Ctrl+",
        checkpoint: "account-shortcuts-windows",
      },
    ]) {
      // Set before the app renders, so every shortcut hint reads the same
      // platform. A later init script overrides an earlier one.
      await page.addInitScript((userAgent) => {
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          get: () => userAgent,
        });
      }, userAgent);
      await page.reload();
      await expect(conversations).toBeVisible({ timeout: 60_000 });
      await page
        .getByRole("button", { name: /playwright-test\+/i })
        .last()
        .click();
      await expect(accountShortcuts).toHaveText([
        `${modifier}0`,
        `${modifier}1`,
        `${modifier}2`,
      ]);
      await capturePlaywrightCheckpoint(page, testInfo, checkpoint);
    }

    await chooseAccountsMenuItem.click();

    const dialog = page.getByRole("dialog", { name: "Choose accounts" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Choose accounts" }),
    ).toBeHidden();
    await expect(
      dialog.getByRole("checkbox", { name: new RegExp(secondAccount.name) }),
    ).toBeChecked();

    await capturePlaywrightCheckpoint(page, testInfo, "all-accounts-selection");

    await dialog
      .getByRole("checkbox", { name: new RegExp(secondAccount.name) })
      .uncheck();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText("All Accounts updated", { exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const response = await page.request.get("/api/user/email-accounts");
        const data = (await response.json()) as {
          emailAccounts: Array<{
            id: string;
            includeInAllAccounts: boolean;
          }>;
        };
        return data.emailAccounts.find(
          (emailAccount) => emailAccount.id === secondAccount.id,
        )?.includeInAllAccounts;
      })
      .toBe(false);
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});
