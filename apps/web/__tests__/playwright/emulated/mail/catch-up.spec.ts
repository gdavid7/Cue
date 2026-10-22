import { expect, type Locator, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  openMail,
  readLatestMailMutation,
  withClient,
} from "./mail-test-helpers";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// Hint ids from utils/get-started/checklist.ts.
const DISMISSED_HINT = "get-started:dismissed";
const KEYBOARD_HINT = "get-started:keyboard";

type SavedUser = { id: string; createdAt: Date; dismissedHints: string[] };
let saved: SavedUser | undefined;

test.describe.configure({ mode: "serial" });

// As a person in their first week; setup closes the checklist, and with it
// Catch up, for every other spec.
test.beforeEach(async () => {
  saved = await withClient(async (client) => {
    const result = await client.query<SavedUser>(
      `SELECT u.id, u."createdAt", u."dismissedHints"
       FROM "User" u INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL],
    );
    const user = result.rows[0];
    if (!user) throw new Error("Could not find the Playwright account");
    await client.query(
      `UPDATE "User"
       SET "createdAt" = NOW() - INTERVAL '1 day',
           "dismissedHints" = array_remove(array_remove("dismissedHints", $2), $3)
       WHERE id = $1`,
      [user.id, DISMISSED_HINT, KEYBOARD_HINT],
    );
    return user;
  });
});

test.afterEach(async () => {
  const user = saved;
  saved = undefined;
  if (!user) return;
  await withClient((client) =>
    client.query(
      `UPDATE "User" SET "createdAt" = $2, "dismissedHints" = $3 WHERE id = $1`,
      [user.id, user.createdAt, user.dismissedHints],
    ),
  );
});

test("works through the oldest unread mail from the keyboard, with undo", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { emailAccountId } = await openMail(page);

  const dialog = await openCatchUp(page);
  const first = await currentThreadId(dialog);
  const startLeft = await leftCount(dialog);
  expect(startLeft).toBeGreaterThan(2);
  expect(startLeft).toBeLessThanOrEqual(10);
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-card-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-card-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // E archives the card's conversation, not the list's focused row.
  await page.keyboard.press("e");
  await expect(dialog.getByText(`${startLeft - 1} left`)).toBeVisible();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "archive",
          threadId: first,
        }),
      { timeout: 60_000 },
    )
    .toBeDefined();
  const second = await currentThreadId(dialog);
  expect(second).not.toBe(first);

  // S keeps it: marked read, and on to the next.
  await page.keyboard.press("s");
  await expect(dialog.getByText(`${startLeft - 2} left`)).toBeVisible();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_read_state",
          threadId: second,
          payload: { read: true },
        }),
      { timeout: 60_000 },
    )
    .toBeDefined();
  expect(await currentThreadId(dialog)).not.toBe(second);

  // Undo puts the kept conversation back where it was, unread again.
  await expect(dialog.getByRole("button", { name: /Undo/ })).toBeVisible();
  await page.keyboard.press("z");
  await expect(dialog.getByText(`${startLeft - 1} left`)).toBeVisible();
  expect(await currentThreadId(dialog)).toBe(second);
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_read_state",
          threadId: second,
          payload: { read: false },
        }),
      { timeout: 60_000 },
    )
    .toBeDefined();
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-after-undo");

  // Focus never leaves the overlay, and Escape closes it.
  for (let step = 0; step < 8; step++) await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("finishes a batch from Today on a phone and counts toward Get started", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, { waitUntil: "domcontentloaded" });

  const dialog = await openCatchUp(page);
  const total = await leftCount(dialog);
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-phone-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-phone-dark");
  await page.emulateMedia({ colorScheme: "light" });

  for (let left = total; left > 0; left--) {
    const before = await currentThreadId(dialog);
    await page.keyboard.press(left % 2 === 0 ? "e" : "s");
    if (left > 1)
      await expect.poll(() => currentThreadId(dialog)).not.toBe(before);
  }

  const finished = dialog.getByText(
    total === 1
      ? "You cleared 1 conversation."
      : `You cleared ${total} conversations.`,
  );
  await expect(finished).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-finished-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-finished-dark");
  await page.emulateMedia({ colorScheme: "light" });

  if (total >= 5) {
    await expect
      .poll(() => hasHint(KEYBOARD_HINT), { timeout: 30_000 })
      .toBe(true);
  }

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

async function openCatchUp(page: Page) {
  const entry = page.locator("[data-catch-up-entry]");
  await expect(entry).toBeVisible({ timeout: 60_000 });
  await entry.getByRole("button", { name: "Catch up" }).click();
  const dialog = page.getByRole("dialog", { name: "Catch up" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-catch-up-card]")).toBeVisible({
    timeout: 60_000,
  });
  return dialog;
}

async function currentThreadId(dialog: Locator) {
  const id = await dialog
    .locator("[data-catch-up-card]")
    .getAttribute("data-catch-up-card");
  if (!id) throw new Error("No Catch up card is showing");
  return id;
}

async function leftCount(dialog: Locator) {
  const text = await dialog.getByText(/^\d+ left$/).textContent();
  return Number(text?.match(/\d+/)?.[0]);
}

async function hasHint(hintId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ has: boolean }>(
      `SELECT $2 = ANY(u."dismissedHints") AS has
       FROM "User" u INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL, hintId],
    );
    return result.rows[0]?.has ?? false;
  });
}
