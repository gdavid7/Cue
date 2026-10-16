import { expect, type Page } from "@playwright/test";
import { test } from "../playwright-test";
import { playwrightMailProvider } from "../mail-provider";
import { openMail } from "../mail/mail-test-helpers";
import { MAIL_ENGINE_OPFS_DIRECTORY } from "@/utils/mail-engine/opfs-mailbox";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// One click used to leave the page waiting forever on the mail engine. A dev
// server renders /login on demand, so it gets more room than a production build.
// The production budget catches that hang, not a slow redirect: loaded CI
// runners have taken 3.1-3.2 s for a normal sign-out, so 4 s leaves headroom.
const SIGN_OUT_BUDGET_MS =
  process.env.PLAYWRIGHT_PRODUCTION === "1" ? 4000 : 15_000;

// Signing out ends the session, so each case signs in on its own instead of
// spending the shared session every other spec runs on.
test.use({ storageState: { cookies: [], origins: [] } });

test("signs out in one click from the mail account menu", async ({ page }) => {
  await openSignedInMail(page);

  await accountMenuButton(page).click();
  const clickedAt = Date.now();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expectSignedOut(page, clickedAt);
});

test("signs out in one click from Settings", async ({ page }) => {
  await openSignedInMail(page);

  await accountMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog");
  await expect(
    settings.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const clickedAt = Date.now();
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();

  await expectSignedOut(page, clickedAt);
});

async function openSignedInMail(page: Page) {
  await signIn(page);
  await openMail(page);
  await expect
    .poll(() => mailEngineOpfsExists(page), { timeout: 30_000 })
    .toBe(true);
}

async function expectSignedOut(page: Page, clickedAt: number) {
  await expect(page.getByText("Signing out…")).toBeVisible({ timeout: 1000 });
  await expect(page).toHaveURL(/\/login(\?|$)/, {
    timeout: SIGN_OUT_BUDGET_MS,
  });
  expect(Date.now() - clickedAt).toBeLessThan(SIGN_OUT_BUDGET_MS);

  // The previous user's mail must not outlive the session on this device.
  await expect
    .poll(() => mailEngineOpfsExists(page), { timeout: 30_000 })
    .toBe(false);
  const session = await page.request.get("/api/auth/get-session");
  expect(await session.json()).toBeNull();
}

function accountMenuButton(page: Page) {
  return page
    .locator("[data-mail-sidebar]")
    .getByRole("button", { name: /Smoke Test User/ });
}

async function signIn(page: Page) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const { url } = await page.evaluate(async (provider) => {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/welcome-redirect" }),
    });
    if (!response.ok) throw new Error(`Sign-in failed: ${response.status}`);
    return (await response.json()) as { url: string };
  }, playwrightMailProvider);
  await page.goto(url);
  await page.getByRole("button", { name: PLAYWRIGHT_TEST_EMAIL }).click();
  await expect(page).not.toHaveURL(/\/login|oauth2|authorize/, {
    timeout: 60_000,
  });
}

async function mailEngineOpfsExists(page: Page) {
  return page.evaluate(async (directory) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(directory);
      return true;
    } catch {
      return false;
    }
  }, MAIL_ENGINE_OPFS_DIRECTORY);
}
