import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { conversationWithSubject, withClient } from "../mail/mail-test-helpers";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// Hint ids from utils/get-started/checklist.ts.
const DISMISSED_HINT = "get-started:dismissed";
const KEYBOARD_HINT = "get-started:keyboard";
const TRIAGE_ROW_SUBJECT = "Keyboard Navigation Message";

type SavedUser = { id: string; createdAt: Date; dismissedHints: string[] };
let saved: SavedUser | undefined;

// As a person in their first week who hasn't triaged from the keyboard yet.
// Setup closes the checklist for every other spec.
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

test("a new user sees Get started on Today and a step checks itself off", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, { waitUntil: "domcontentloaded" });

  const checklist = page.getByRole("region", { name: "Get started with Cue" });
  await expect(checklist).toBeVisible({ timeout: 60_000 });
  const keyboardStep = checklist.locator('[data-get-started-item="keyboard"]');
  await expect(keyboardStep).toHaveAttribute("data-done", "false");
  const doneBefore = await doneCount(page);
  await capturePlaywrightCheckpoint(page, testInfo, "get-started-today");

  // The step's link goes to the inbox, where five triage keys complete it.
  await keyboardStep.getByRole("link").click();
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  const row = conversationWithSubject(page, conversations, TRIAGE_ROW_SUBJECT);
  await row.getByRole("checkbox", { includeHidden: true }).click();
  const starred = row.getByText("Starred conversation", { exact: true });
  const startsStarred = (await starred.count()) > 0;
  // An even number of stars leaves the row as later specs expect it.
  for (let press = 1; press <= 6; press++) {
    await page.keyboard.press("s");
    await expect(starred).toHaveCount(
      (press % 2 === 1) !== startsStarred ? 1 : 0,
    );
  }
  await expect
    .poll(() => hasHint(KEYBOARD_HINT), { timeout: 30_000 })
    .toBe(true);

  await page.goto(`/${emailAccountId}/home`, { waitUntil: "domcontentloaded" });
  await expect(keyboardStep).toHaveAttribute("data-done", "true", {
    timeout: 60_000,
  });
  expect(await doneCount(page)).toBe(doneBefore + 1);
  await capturePlaywrightCheckpoint(page, testInfo, "get-started-step-done");

  // Closing it is for good.
  await checklist.getByRole("button", { name: "Hide checklist" }).click();
  await expect(checklist).toBeHidden();
  await expect.poll(() => hasHint(DISMISSED_HINT)).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(checklist).toHaveCount(0);
});

async function doneCount(page: Page) {
  return page
    .getByRole("region", { name: "Get started with Cue" })
    .locator('[data-done="true"]')
    .count();
}

async function hasHint(hintId: string) {
  const user = saved;
  if (!user) throw new Error("Checklist state was not prepared");
  return withClient(async (client) => {
    const result = await client.query<{ has: boolean }>(
      `SELECT $2 = ANY("dismissedHints") AS has FROM "User" WHERE id = $1`,
      [user.id, hintId],
    );
    return result.rows[0]?.has ?? false;
  });
}
