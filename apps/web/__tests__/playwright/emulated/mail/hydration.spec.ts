import { expect, type Page } from "@playwright/test";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

// React reports a server/client render mismatch as a console error: minified
// errors #418/#423/#425 in a production build, a "Hydration failed" or
// "didn't match" message in development. Neither throws, so the shared
// fixture's page-error check does not catch it.
const HYDRATION_ERROR =
  /Minified React error #(418|423|425)|hydrat|didn't match|did not match/i;

test("renders the main pages without a hydration mismatch", async ({
  page,
  browser,
}) => {
  const hydrationErrors = watchHydrationErrors(page);
  const { conversations, emailAccountId } = await openMail(page);
  await settle(page);

  // A thread address renders the reader on the server too.
  await conversations.getByRole("option").first().click();
  await expect(page).toHaveURL(/\/mail\/u\/\d+\/.+\/.+/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("thread-reader")).toBeVisible({
    timeout: 60_000,
  });
  await settle(page);

  // A saved theme that differs from the OS one is applied before hydration.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/${emailAccountId}/mail`, {
    waitUntil: "domcontentloaded",
  });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("main").first()).toBeVisible({ timeout: 60_000 });
  await settle(page);

  await page.goto(`/${emailAccountId}/settings`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("main").first()).toBeVisible({ timeout: 60_000 });
  await settle(page);

  const signedOut = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const loginPage = await signedOut.newPage();
    const loginErrors = watchHydrationErrors(loginPage);
    await loginPage.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(
      loginPage.getByRole("button", { name: /Google/ }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await settle(loginPage);
    hydrationErrors.push(...loginErrors);
  } finally {
    await signedOut.close();
  }

  expect(hydrationErrors).toEqual([]);
});

function watchHydrationErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (HYDRATION_ERROR.test(text)) errors.push(`${page.url()}: ${text}`);
  });
  page.on("pageerror", (error) => {
    if (HYDRATION_ERROR.test(error.message))
      errors.push(`${page.url()}: ${error.message}`);
  });
  return errors;
}

// Hydration runs once the page's scripts load; recoverable errors are
// reported right after it.
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
}
