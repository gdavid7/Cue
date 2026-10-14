import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { conversationWithSubject, openMail } from "../mail/mail-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";

// The dark `--background` token, #26282C.
const DARK_BACKGROUND = "rgb(38, 40, 44)";
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

const PAGES: {
  name: string;
  path: (emailAccountId: string) => string;
  ready: (page: Page) => Locator;
}[] = [
  {
    name: "today",
    path: (id) => `/${id}/home`,
    ready: (page) =>
      page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ }),
  },
  {
    name: "rules",
    path: (id) => `/${id}/automation`,
    ready: (page) => page.getByRole("heading", { name: "Rules", exact: true }),
  },
  {
    name: "chat",
    path: (id) => `/${id}/assistant`,
    ready: (page) => page.getByText("Chat with Cue").first(),
  },
  {
    name: "settings",
    path: () => "/settings",
    ready: (page) =>
      page.getByRole("heading", { name: "Settings", exact: true }),
  },
];

test("a saved dark theme applies before first paint on the main screens", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  // The OS says light, so only the saved preference can make these dark.
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await recordThemeAtParse(page);

  // One load of Mail covers its screens; each further reload restarts the
  // local mail engine, which these assertions don't need.
  const { conversations, emailAccountId } = await openMail(page);
  await expectDarkPage(page);
  await captureAtEachWidth(page, testInfo, "inbox", conversations);

  await page.getByRole("button", { name: /^Compose/ }).click();
  const composer = page.getByRole("dialog");
  await captureAtEachWidth(
    page,
    testInfo,
    "compose",
    composer.locator("[contenteditable='true']"),
  );
  await page.keyboard.press("Escape");
  await expect(composer).toBeHidden();

  await conversationWithSubject(page, conversations, "Playwright Test Message")
    .first()
    .click();
  await captureAtEachWidth(
    page,
    testInfo,
    "open-thread",
    page.getByRole("heading", { name: "Playwright Test Message" }),
  );

  for (const screen of PAGES) {
    await page.goto(screen.path(emailAccountId));
    await expect(screen.ready(page)).toBeVisible({ timeout: 60_000 });
    await expectDarkPage(page);
    await captureAtEachWidth(page, testInfo, screen.name, screen.ready(page));
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
    await recordThemeAtParse(page);
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Google/ })).toBeVisible({
      timeout: 60_000,
    });
    await expectDarkPage(page);
    await capturePlaywrightCheckpoint(page, testInfo, "dark-login");
  });
});

async function captureAtEachWidth(
  page: Page,
  testInfo: TestInfo,
  name: string,
  ready: Locator,
) {
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await expect(ready).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      `dark-${name}-${size.width}`,
    );
  }
  await page.setViewportSize(WIDTHS[0]);
}

async function recordThemeAtParse(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as { themeAtParse?: string }).themeAtParse =
        document.documentElement.className;
    });
  });
}

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
  expect(themeAtParse).toMatch(/\bdark\b/);
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
