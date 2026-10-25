import { expect, type Request } from "@playwright/test";
import {
  deleteLinkedOutlookAccount,
  getEmailAccount,
  linkOutlookAccount,
} from "../account-test-helpers";
import {
  resetCalendarTestState,
  setupCalendarTestState,
} from "../calendars/calendar-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { withClient } from "./mail-test-helpers";

const OUTLOOK_EMAIL = process.env.PLAYWRIGHT_LINKED_OUTLOOK_EMAIL ?? "";
const GMAIL_THREAD = "thr_playwright_1";
const OUTLOOK_THREAD = "thr_playwright_linked_outlook";
const OUTLOOK_SUBJECT = "Linked Outlook Message";
const SEED_PREFIX = "playwright-mixed-";
// The linked emulator's calendar holding only "Outlook design review"; see
// writeLinkedMicrosoftSeed in playwright.config.mjs.
const OUTLOOK_MEETING_CALENDAR = "cal_playwright_linked_design";
const commandModifier = process.platform === "darwin" ? "Meta" : "Control";

test.skip(
  isMicrosoftPlaywright(),
  "Google runs start a second, Microsoft emulator for the Outlook mailbox to link.",
);

type Accounts = {
  gmail: { id: string; email: string };
  outlook: { id: string; email: string };
};

let accounts: Accounts | undefined;
let second: Awaited<ReturnType<typeof createSecondEmailAccount>> | undefined;

test.beforeEach(async ({ page }) => {
  test.setTimeout(480_000);
  expect(OUTLOOK_EMAIL).not.toBe("");
  const gmail = await getEmailAccount(page);
  await linkOutlookAccount(page, OUTLOOK_EMAIL);
  const outlook = {
    id: await emailAccountIdFor(OUTLOOK_EMAIL),
    email: OUTLOOK_EMAIL,
  };
  accounts = { gmail, outlook };

  await setupCalendarTestState();
  // Linking connects the Outlook calendar, as sign-in does.
  await expect
    .poll(() => calendarConnections(outlook.id), { timeout: 30_000 })
    .toBe(1);
  // The emulator seeds its own meetings on the default calendars, ahead of the
  // Gmail one; turned off, as the person can, they leave Next up to the two
  // meetings this spec is about.
  await expect
    .poll(() => onlyOutlookMeetingCalendar(outlook.id), { timeout: 30_000 })
    .toBe(true);
  for (const [account, threadId] of [
    [gmail, GMAIL_THREAD],
    [outlook, OUTLOOK_THREAD],
  ] as const) {
    await seedNeedsReply(account.id, threadId);
    await seedDraft(account.id, threadId, `Draft for ${account.email}`);
  }
});

test.afterEach(async () => {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM "ThreadTracker" WHERE "messageId" LIKE $1`,
      [`${SEED_PREFIX}%`],
    );
    await client.query(`DELETE FROM "ExecutedRule" WHERE id LIKE $1`, [
      `${SEED_PREFIX}%`,
    ]);
  });
  await resetCalendarTestState();
  await deleteLinkedOutlookAccount(OUTLOOK_EMAIL);
  if (second) await deleteSecondEmailAccount(second.accountId);
  second = undefined;
  accounts = undefined;
});

test("Today across a Gmail and an Outlook account names each one's mail, drafts and meetings", async ({
  page,
}, testInfo) => {
  const { gmail, outlook } = accounts!;

  // Opened from the Outlook account, Today still greets the user by name.
  await page.goto(`/${outlook.id}/home?accounts=all`);
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1 }),
  ).toHaveText(/^(Hello|Good \w+), Smoke$/);

  for (const [account, threadId] of [
    [gmail, GMAIL_THREAD],
    [outlook, OUTLOOK_THREAD],
  ] as const) {
    await expect(
      page
        .locator(`[data-today-thread="${account.id}:${threadId}"]`)
        .getByRole("img", { name: `Inbox: ${account.email}` }),
    ).toBeVisible({ timeout: 90_000 });

    const draft = page
      .getByRole("region", { name: "Drafts ready for you" })
      .getByRole("link")
      .filter({ hasText: `Draft for ${account.email}` });
    await expect(
      draft.getByRole("img", { name: `Inbox: ${account.email}` }),
    ).toBeVisible();
  }

  // With a Gmail and an Outlook calendar connected, a meeting says whose
  // calendar it's on: on the Your day strip when it's today, in Next up
  // when the seeded time falls tomorrow.
  const meetings = page
    .getByRole("main")
    .getByRole("region", { name: /^(Your day|Next up)$/ });
  await expect(
    meetings.getByText(gmail.email, { exact: false }).first(),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    meetings
      .getByRole("listitem")
      .filter({ hasText: "Outlook design review" })
      .getByText(outlook.email, { exact: false }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "today-mixed-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "today-mixed-phone-dark");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  // An Outlook draft opens in All inboxes, in the Outlook account.
  await page
    .getByRole("region", { name: "Drafts ready for you" })
    .getByRole("link")
    .filter({ hasText: `Draft for ${outlook.email}` })
    .click();
  await expect(page).toHaveURL(/\/all-inboxes\//, { timeout: 60_000 });
  await expect(page).toHaveURL(/[?&]from=today/);
  await expect(
    page.getByRole("heading", { name: OUTLOOK_SUBJECT }),
  ).toBeVisible({ timeout: 60_000 });
});

test("Command K in All inboxes says which account it acts in, and acts there", async ({
  page,
}, testInfo) => {
  const { gmail, outlook } = accounts!;
  const operations: string[] = [];
  page.context().on("request", (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/operations/"))
      operations.push(request.url());
  });

  await page.goto(`/${gmail.id}/mail?accountScope=all`);
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  const outlookRow = conversations
    .getByRole("option")
    .filter({ hasText: OUTLOOK_SUBJECT });
  await expect(outlookRow).toBeVisible({ timeout: 90_000 });
  await outlookRow.getByRole("checkbox", { includeHidden: true }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();

  await page.keyboard.press(`${commandModifier}+KeyK`);
  const palette = page.getByRole("dialog");
  await expect(palette.getByText(`Actions · ${outlook.email}`)).toBeVisible();
  // The open account's own pages say whose they are.
  await expect(
    palette
      .getByRole("option")
      .filter({ has: page.getByText("Go to Rules", { exact: true }) })
      .getByText(gmail.email, { exact: true }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(palette, testInfo, "palette-all-inboxes");

  const markRead = palette
    .getByRole("option")
    .filter({ has: page.getByText(/^Mark as (read|unread)$/) });
  await markRead.first().click();
  await expect(palette).toBeHidden();
  await expect
    .poll(() => operationAccounts(operations), { timeout: 60_000 })
    .toEqual([outlook.id]);
});

test("Deep Clean from All inboxes offers only the Gmail accounts in it", async ({
  page,
}, testInfo) => {
  const { gmail } = accounts!;
  second = await createSecondEmailAccount(gmail.id);
  const excluded = await createSecondEmailAccount(gmail.id);
  try {
    await withClient((client) =>
      client.query(
        `UPDATE "EmailAccount" SET "includeInAllAccounts" = false WHERE id = $1`,
        [excluded.id],
      ),
    );

    // Looking at All inboxes is what makes the next page show every account.
    await page.goto(`/${gmail.id}/mail?accountScope=all`);
    await expect(
      page.getByRole("listbox", { name: "Conversations" }),
    ).toBeVisible({ timeout: 90_000 });
    await page.goto(`/${gmail.id}/clean/onboarding`);

    const picker = page.getByRole("combobox", { name: "Account" });
    await expect(picker).toHaveText(gmail.email, { timeout: 90_000 });
    await picker.click();
    // Only the Gmail accounts in All inboxes: not Outlook, not one left out.
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
      gmail.email,
      second.email,
    ]);
    await capturePlaywrightCheckpoint(page, testInfo, "deep-clean-picker");

    await page.getByRole("option", { name: second.email }).click();
    await expect(page).toHaveURL(new RegExp(`/${second.id}/clean`), {
      timeout: 60_000,
    });
    await expect(picker).toHaveText(second.email, { timeout: 90_000 });
  } finally {
    await deleteSecondEmailAccount(excluded.accountId);
  }
});

async function emailAccountIdFor(email: string) {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM "EmailAccount" WHERE email = $1`,
      [email],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("The linked Outlook account is missing");
    return id;
  });
}

async function calendarConnections(emailAccountId: string) {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM "CalendarConnection" WHERE "emailAccountId" = $1`,
      [emailAccountId],
    );
    return result.rowCount ?? 0;
  });
}

async function onlyOutlookMeetingCalendar(emailAccountId: string) {
  return withClient(async (client) => {
    const synced = await client.query(
      `SELECT 1 FROM "Calendar" calendar
       JOIN "CalendarConnection" connection ON connection.id = calendar."connectionId"
       WHERE connection."emailAccountId" = $1 AND calendar."calendarId" = $2`,
      [emailAccountId, OUTLOOK_MEETING_CALENDAR],
    );
    if (!synced.rowCount) return false;
    await client.query(
      `UPDATE "Calendar" SET "isEnabled" = false
       WHERE "calendarId" <> $2 AND "connectionId" IN
         (SELECT id FROM "CalendarConnection" WHERE "emailAccountId" = $1)`,
      [emailAccountId, OUTLOOK_MEETING_CALENDAR],
    );
    return true;
  });
}

async function seedNeedsReply(emailAccountId: string, threadId: string) {
  await withClient((client) =>
    client.query(
      `INSERT INTO "ThreadTracker" ("id", "updatedAt", "sentAt", "threadId", "messageId", "type", "emailAccountId")
       VALUES ($1, now(), now(), $2, $1, 'NEEDS_REPLY', $3)
       ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET "resolved" = false`,
      [`${SEED_PREFIX}${emailAccountId}-${threadId}`, threadId, emailAccountId],
    ),
  );
}

// An AI reply draft waiting for review, as a rule leaves one.
async function seedDraft(
  emailAccountId: string,
  threadId: string,
  subject: string,
) {
  const id = `${SEED_PREFIX}${emailAccountId}-draft`;
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO "ExecutedRule"
         (id, "threadId", "messageId", status, automated, "emailAccountId",
          "createdAt", "updatedAt")
       VALUES ($1, $2, $1, 'APPLIED', true, $3, CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP)`,
      [id, threadId, emailAccountId],
    );
    await client.query(
      `INSERT INTO "ExecutedAction"
         (id, type, subject, "draftStatus", "executedRuleId", "createdAt",
          "updatedAt")
       VALUES ($1, 'DRAFT_EMAIL', $2, 'PENDING', $3, CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP)`,
      [`${id}-action`, subject, id],
    );
  });
}

function operationAccounts(urls: string[]) {
  return [
    ...new Set(
      urls.map((url) =>
        decodeURIComponent(
          /\/api\/mail\/v1\/accounts\/([^/]+)\/operations\//.exec(url)?.[1] ??
            "",
        ),
      ),
    ),
  ];
}
