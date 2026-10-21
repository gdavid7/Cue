import { expect, type Page } from "@playwright/test";
import { getEmailAccount } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  grantAiAccess,
  openMail,
  openThreadIdFromUrl,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

type ExtraAccount = Awaited<ReturnType<typeof createSecondEmailAccount>>;

let restorePlans: (() => Promise<void>) | undefined;
let extraAccounts: ExtraAccount[] = [];

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

test.afterEach(async () => {
  for (const account of extraAccounts)
    await deleteSecondEmailAccount(account.accountId);
  extraAccounts = [];
});

test("Cue found in All inboxes searches every included account and opens each row in its own", async ({
  page,
}, testInfo) => {
  const { emailAccountId: primaryId } = await openMail(page);
  const primary = await getEmailAccount(page);
  // Every account here reads the same seeded mailbox, so one message is
  // found once in each account Cue searches.
  const included = await createSecondEmailAccount(primaryId);
  const excluded = await createSecondEmailAccount(primaryId);
  extraAccounts = [included, excluded];
  await withClient((client) =>
    client.query(
      `UPDATE "EmailAccount" SET "includeInAllAccounts" = false WHERE id = $1`,
      [excluded.id],
    ),
  );

  const cueToken = randomToken();
  const subject = `Harvest invoice ${cueToken}`;
  const threadId = await insertInboxMail(page, subject);
  let intentCalls = 0;
  await page.route("**/api/user/search-intent", async (route) => {
    intentCalls++;
    await route.fulfill({
      json: {
        searches: [cueToken],
        editableSearches: [cueToken],
        unreadOnly: false,
        explanation: "Harvest invoices",
        isQuestion: false,
        timeZone: "UTC",
        parts: {
          senders: [],
          recipients: [],
          sentByUser: false,
          keywordGroups: [[cueToken]],
          hasAttachment: false,
          unread: false,
          starred: false,
          label: "",
          dateRange: "none",
          lastNDays: 0,
          fromDate: "",
          toDate: "",
          explanation: "Harvest invoices",
          isQuestion: false,
        },
      },
    });
  });

  await page.goto(`/${primaryId}/mail?accountScope=all`);
  const searchInput = page.getByPlaceholder("Search mail");
  await expect(searchInput).toBeVisible({ timeout: 60_000 });
  // Words that match no mail, so every row found is Cue's.
  await searchInput.fill(`${randomToken()} orchard receipts`);
  await searchInput.press("Enter");

  const cueSection = page.getByRole("listbox", { name: "Mail Cue found" });
  const cueRows = cueSection
    .getByRole("option")
    .filter({ has: page.getByText(subject, { exact: true }) });
  await expect(cueRows).toHaveCount(2, { timeout: 60_000 });
  const rowOf = (email: string) =>
    cueRows.filter({
      has: page.getByRole("img", { name: `Inbox: ${email}`, exact: true }),
    });
  await expect(rowOf(primary.email)).toHaveCount(1);
  await expect(rowOf(included.email)).toHaveCount(1);
  await expect(
    cueSection.getByRole("img", { name: `Inbox: ${excluded.email}` }),
  ).toHaveCount(0);
  // The model reads the search once, however many accounts it covers.
  expect(intentCalls).toBe(1);
  await capturePlaywrightCheckpoint(page, testInfo, "cue-found-all-inboxes");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cueRows).toHaveCount(2);
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "cue-found-all-inboxes-phone",
  );
  await page.setViewportSize({ width: 1280, height: 900 });

  await rowOf(included.email).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
  // The second included account, opened in its own scope.
  await expect(page).toHaveURL(/[?&]account=1(&|$)/);
  await expect.poll(() => openThreadIdFromUrl(page.url())).toBe(threadId);
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "cue-found-all-inboxes-opened",
  );
});

async function insertInboxMail(page: Page, subject: string) {
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
        subject,
        body_text: "Cue found coverage across accounts.",
        labelIds: ["INBOX"],
        internalDate: String(Date.now()),
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
