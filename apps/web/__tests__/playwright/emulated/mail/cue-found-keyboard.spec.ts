import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { test } from "../playwright-test";
import {
  grantAiAccess,
  openMail,
  openThreadIdFromUrl,
  readLatestMailMutation,
  readProviderAccessToken,
} from "./mail-test-helpers";

let restorePlans: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  if (isMicrosoftPlaywright()) return;
  restorePlans = await grantAiAccess();
});

test.afterAll(async () => {
  await restorePlans?.();
  restorePlans = undefined;
});

test.beforeEach(() => {
  test.skip(
    isMicrosoftPlaywright(),
    "The mail is seeded through the Gmail emulator.",
  );
});

test("J and K cross between Cue's rows and the plain list", async ({
  page,
}) => {
  const { cueRows, plainRows } = await openCueSearch(page);

  await cueRows[0].row.focus();
  await expect(cueRows[0].row).toBeFocused();

  await page.keyboard.press("j");
  await expect(cueRows[1].row).toBeFocused();
  await page.keyboard.press("j");
  await expect(plainRows[0].row).toBeFocused();
  await page.keyboard.press("j");
  await expect(plainRows[1].row).toBeFocused();

  await page.keyboard.press("k");
  await expect(plainRows[0].row).toBeFocused();
  await page.keyboard.press("k");
  await expect(cueRows[1].row).toBeFocused();
  await page.keyboard.press("k");
  await expect(cueRows[0].row).toBeFocused();
});

test("Enter opens the focused Cue row", async ({ page }) => {
  const { cueRows } = await openCueSearch(page);

  await cueRows[0].row.focus();
  await page.keyboard.press("j");
  await expect(cueRows[1].row).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("heading", { name: cueRows[1].subject }),
  ).toBeVisible();
  await expect
    .poll(() => openThreadIdFromUrl(page.url()))
    .toBe(cueRows[1].threadId);
});

test("Space selects the focused Cue row", async ({ page }) => {
  const { cueRows, plainRows } = await openCueSearch(page);

  await cueRows[0].row.focus();
  await page.keyboard.press("Space");

  await expect(cueRows[0].row).toHaveAttribute("aria-selected", "true");
  await expect(cueRows[1].row).toHaveAttribute("aria-selected", "false");
  await expect(plainRows[0].row).toHaveAttribute("aria-selected", "false");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
});

test("archives the focused Cue row and no other thread", async ({ page }) => {
  const { cueRows, plainRows, emailAccountId } = await openCueSearch(page);

  await cueRows[0].row.focus();
  await page.keyboard.press("j");
  await expect(cueRows[1].row).toBeFocused();
  await page.keyboard.press("e");

  await expectArchived(page, emailAccountId, cueRows[1].threadId);
  await expectNotArchived(page, emailAccountId, [
    cueRows[0].threadId,
    plainRows[0].threadId,
    plainRows[1].threadId,
  ]);
});

test("archives a selection of a Cue row and a plain row together", async ({
  page,
}) => {
  const { cueRows, plainRows, emailAccountId } = await openCueSearch(page);

  await cueRows[0].row.focus();
  await page.keyboard.press("Space");
  await expect(cueRows[0].row).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(plainRows[0].row).toBeFocused();
  await page.keyboard.press("Space");
  await expect(plainRows[0].row).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("e");

  await expectArchived(page, emailAccountId, cueRows[0].threadId);
  await expectArchived(page, emailAccountId, plainRows[0].threadId);
  await expectNotArchived(page, emailAccountId, [
    cueRows[1].threadId,
    plainRows[1].threadId,
  ]);
});

/**
 * Seeds two threads Cue's stubbed search finds and two the typed words match,
 * then commits the typed search. The words and Cue's search are unrelated, so
 * no row is in both lists and Cue shows all of its own.
 */
async function openCueSearch(page: Page) {
  const wordsToken = randomToken();
  const cueToken = randomToken();
  const baseTime = Date.now();
  const mails = [
    { subject: `Harvest invoice ${cueToken} one`, cue: true },
    { subject: `Harvest invoice ${cueToken} two`, cue: true },
    { subject: `Orchard receipts ${wordsToken} one`, cue: false },
    { subject: `Orchard receipts ${wordsToken} two`, cue: false },
  ];
  // Newest first, the order both lists show.
  const seeded: SeededMail[] = [];
  for (const [index, mail] of mails.entries()) {
    seeded.push({
      ...mail,
      threadId: await insertInboxMail(page, {
        subject: mail.subject,
        internalDate: baseTime - index * 60_000,
      }),
    });
  }

  await page.route("**/api/user/search-intent", async (route) => {
    await route.fulfill({
      json: {
        searches: [cueToken],
        editableSearches: [cueToken],
        unreadOnly: false,
        explanation: "Harvest invoices",
        isQuestion: false,
        timeZone: "UTC",
      },
    });
  });

  const { emailAccountId } = await openMail(page);
  const searchInput = page.getByPlaceholder("Search mail");
  await searchInput.fill(`${wordsToken} orchard receipts`);
  await searchInput.press("Enter");

  const cueSection = page.getByRole("listbox", { name: "Mail Cue found" });
  const plainList = page.getByRole("listbox", { name: "Conversations" });
  await expect(cueSection.getByRole("option")).toHaveCount(2);
  await expect(plainList.getByRole("option")).toHaveCount(2);

  const rowsOf = (list: Locator, group: SeededMail[]) =>
    group.map((mail) => ({
      ...mail,
      row: list
        .getByRole("option")
        .filter({ has: page.getByText(mail.subject, { exact: true }) }),
    }));
  return {
    emailAccountId,
    cueRows: rowsOf(
      cueSection,
      seeded.filter((mail) => mail.cue),
    ),
    plainRows: rowsOf(
      plainList,
      seeded.filter((mail) => !mail.cue),
    ),
  };
}

async function expectArchived(
  page: Page,
  emailAccountId: string,
  threadId: string,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "archive",
          threadId,
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}

// Run after the archives that were expected have landed, so a wrong extra
// target would already have been queued with them.
async function expectNotArchived(
  page: Page,
  emailAccountId: string,
  threadIds: string[],
) {
  for (const threadId of threadIds) {
    expect(
      await readLatestMailMutation(page, {
        emailAccountId,
        kind: "archive",
        threadId,
      }),
    ).toBeUndefined();
  }
}

async function insertInboxMail(
  page: Page,
  input: { subject: string; internalDate: number },
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const inserted = await page.request.post(
    `${baseUrl}/gmail/v1/users/me/messages`,
    {
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
        "content-type": "application/json",
      },
      data: {
        from: "Sam Seller <sam@vendor.example>",
        to: email,
        subject: input.subject,
        body_text: "Keyboard coverage for Cue's rows.",
        labelIds: ["INBOX"],
        internalDate: String(input.internalDate),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  return ((await inserted.json()) as { threadId: string }).threadId;
}

// Letters only, so the search reads it as one word and never as a number.
function randomToken() {
  return Array.from({ length: 10 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
}

type SeededMail = { subject: string; cue: boolean; threadId: string };
