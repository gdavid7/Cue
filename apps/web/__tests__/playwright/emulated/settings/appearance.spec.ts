import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import { openSettings } from "./settings-test-helpers";

let previousTheme: string | null | undefined;

test.beforeEach(() => {
  previousTheme = undefined;
});

test.afterEach(async ({ page }) => {
  if (previousTheme === undefined) return;

  await page.evaluate((theme) => {
    if (theme === null) localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  }, previousTheme);
  await page.reload();
});

test("persists the global appearance across reloads", async ({ page }) => {
  await openSettings(page);

  previousTheme = await page.evaluate(() => localStorage.getItem("theme"));
  const themeSelect = page.getByRole("combobox", { name: "Theme" });
  await expect(themeSelect).toBeEnabled();
  const enableDarkMode = !(await page
    .locator("html")
    .evaluate((html) => html.classList.contains("dark")));
  const expectedTheme = enableDarkMode ? "dark" : "light";
  const expectedLabel = enableDarkMode ? "Dark" : "Light";

  await themeSelect.click();
  await page.getByRole("option", { name: expectedLabel, exact: true }).click();
  await expect(themeSelect).toHaveText(expectedLabel);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("theme")))
    .toBe(expectedTheme);
  await expectThemeClass(page, enableDarkMode);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("combobox", { name: "Theme" })).toHaveText(
    expectedLabel,
  );
  await expectThemeClass(page, enableDarkMode);
});

async function expectThemeClass(
  page: Parameters<typeof openSettings>[0],
  dark: boolean,
) {
  const html = page.locator("html");
  if (dark) await expect(html).toHaveClass(/dark/);
  else await expect(html).not.toHaveClass(/dark/);
}
