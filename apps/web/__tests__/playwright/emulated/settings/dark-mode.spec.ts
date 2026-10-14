import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { openMail } from "../mail/mail-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openSettings } from "./settings-test-helpers";

// The dark `--background` token, #26282C.
const DARK_BACKGROUND = "rgb(38, 40, 44)";

const SCREENS: {
  name: string;
  open: (page: Page, emailAccountId: string) => Promise<void>;
}[] = [
  {
    name: "inbox",
    open: async (page) => {
      await openMail(page);
    },
  },
  {
    name: "open thread",
    open: async (page, emailAccountId) => {
      await page.goto(
        `/${emailAccountId}/mail?thread-id=thr_playwright_theme_system`,
      );
      await expect(
        page.getByRole("heading", { name: "System Theme Message" }),
      ).toBeVisible({ timeout: 60_000 });
    },
  },
  {
    name: "compose",
    open: async (page) => {
      await openMail(page);
      await page.getByRole("button", { name: /^Compose/ }).click();
      await expect(
        page.getByRole("dialog").locator("[contenteditable='true']"),
      ).toBeVisible();
    },
  },
  {
    name: "today",
    open: async (page, emailAccountId) => {
      await page.goto(`/${emailAccountId}/home`);
      await expect(
        page.getByRole("heading", {
          name: /^Good (morning|afternoon|evening)/,
        }),
      ).toBeVisible({ timeout: 60_000 });
    },
  },
  {
    name: "rules",
    open: async (page, emailAccountId) => {
      await page.goto(`/${emailAccountId}/automation`);
      await expect(
        page.getByRole("heading", { name: "Rules", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    },
  },
  {
    name: "chat",
    open: async (page, emailAccountId) => {
      await page.goto(`/${emailAccountId}/assistant`);
      await expect(page.getByText("Chat with Cue").first()).toBeVisible({
        timeout: 60_000,
      });
    },
  },
  {
    name: "settings",
    open: openSettings,
  },
];

test("a saved dark theme applies before first paint on the main screens", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  // The OS says light, so only the saved preference can make these dark.
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    localStorage.setItem("theme", "dark");
    document.addEventListener("DOMContentLoaded", () => {
      (window as { themeAtParse?: string }).themeAtParse =
        document.documentElement.className;
    });
  });
  const emailAccountId = await getEmailAccountId(page);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 400 ? 800 : 844 });
    for (const screen of SCREENS) {
      await screen.open(page, emailAccountId);
      await expectDarkPage(page);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `dark-${screen.name}-${width}`,
      );
    }
  }
});

test("the account menu switches between light, dark and system", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openMail(page);
  const html = page.locator("html");

  await chooseAppearance(page, "Dark");
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(html).toHaveCSS("color-scheme", "dark");
  await expect(
    page.locator('meta[name="theme-color"]').first(),
  ).toHaveAttribute("content", DARK_BACKGROUND);

  await page.reload();
  await expect(
    page.getByRole("listbox", { name: "Conversations" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(html).toHaveClass(/\bdark\b/);

  await chooseAppearance(page, "Light");
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(html).toHaveCSS("color-scheme", "light");

  await chooseAppearance(page, "System");
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-in follows a dark OS by default", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Google/ })).toBeVisible({
      timeout: 60_000,
    });
    await expectDarkPage(page);
    await capturePlaywrightCheckpoint(page, testInfo, "dark-login");
  });
});

async function expectDarkPage(page: Page) {
  const html = page.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(html).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    DARK_BACKGROUND,
  );
  // Set by the inline theme script while the document parses, not after
  // hydration, so the page never paints light first.
  const themeAtParse = await page.evaluate(
    () => (window as { themeAtParse?: string }).themeAtParse,
  );
  if (themeAtParse !== undefined) expect(themeAtParse).toMatch(/\bdark\b/);
}

async function chooseAppearance(page: Page, label: string) {
  await page
    .getByRole("button", { name: /^Account and settings/ })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Appearance" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await page.keyboard.press("Escape");
}
