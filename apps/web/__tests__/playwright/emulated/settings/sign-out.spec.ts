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
  const unauthorized = collectUnauthorizedApiResponses(page);
  const clickedAt = Date.now();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expectSignedOut(page, clickedAt);
  expect(unauthorized).toEqual([]);
});

test("signs out in one click from Settings", async ({ page }) => {
  await openSignedInMail(page);

  await accountMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog");
  await expect(
    settings.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const unauthorized = collectUnauthorizedApiResponses(page);
  const clickedAt = Date.now();
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();

  await expectSignedOut(page, clickedAt);
  expect(unauthorized).toEqual([]);
});

test("recovers in place when the server rejects a live session once", async ({
  page,
}) => {
  await openSignedInMail(page);

  // Each settings and account read is rejected the first time it is asked,
  // as the auth gate does when a session lookup misses for a moment.
  const rejected = new Set<string>();
  const recovered = new Set<string>();
  let refreshes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/get-session?disableCookieCache"))
      refreshes++;
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (rejected.has(path) && response.ok()) recovered.add(path);
  });
  await page.route(/\/api\/user\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || rejected.has(path))
      return route.continue();
    rejected.add(path);
    return route.fulfill({
      status: 401,
      json: {
        error: "Unauthorized",
        errorCode: "SESSION_EXPIRED",
        isKnownError: true,
      },
    });
  });

  await page.reload();
  await expect(accountMenuButton(page)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => rejected.size, { timeout: 30_000 })
    .toBeGreaterThan(2);
  await expect
    .poll(() => [...rejected].filter((path) => !recovered.has(path)), {
      timeout: 30_000,
    })
    .toEqual([]);

  expect(page.url()).not.toMatch(/\/login(\?|$)/);
  // One refresh answers a whole burst of rejected reads.
  expect(refreshes).toBeGreaterThan(0);
  expect(refreshes).toBeLessThan(rejected.size);
});

test("still sends the page to log in when the session is gone", async ({
  page,
}) => {
  await openSignedInMail(page);

  await page.context().clearCookies({ name: /session_token/ });
  // Revalidating on focus is the next read the page makes on its own.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 30_000 });
});

// Requests the page sends after the session row is deleted answer 401. Once
// sign-out starts the page must send none, or the burst reads as a session
// expiring under the user.
function collectUnauthorizedApiResponses(page: Page) {
  const unauthorized: string[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (response.status() === 401 && pathname.startsWith("/api/"))
      unauthorized.push(pathname);
  });
  return unauthorized;
}

async function openSignedInMail(page: Page) {
  await signIn(page);
  await openMail(page);
  await expect
    .poll(() => mailEngineOpfsExists(page), { timeout: 30_000 })
    .toBe(true);
}

async function expectSignedOut(page: Page, clickedAt: number) {
  // "Signing out…" is transient: on a fast runner the page is already on
  // /login, so the redirect and the cleared session are the real outcome.
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
    // Better Auth allows three sign-ins per IP every 10 seconds, and a retried
    // test signs in again, so wait out a 429 instead of failing on it.
    for (let attempt = 0; ; attempt++) {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, callbackURL: "/welcome-redirect" }),
      });
      if (response.status === 429 && attempt < 3) {
        const retryAfterHeader = Number(response.headers.get("X-Retry-After"));
        const retryAfterSeconds =
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader
            : 10;
        await new Promise((resolve) =>
          setTimeout(resolve, (retryAfterSeconds + 1) * 1000),
        );
        continue;
      }
      if (!response.ok) throw new Error(`Sign-in failed: ${response.status}`);
      return (await response.json()) as { url: string };
    }
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
