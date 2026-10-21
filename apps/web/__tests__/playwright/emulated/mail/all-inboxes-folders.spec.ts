import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  conversationWithSubject,
  openMail,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

const SENT_SUBJECT = "Seeded Sent Message";
const SENT_MESSAGE_ID = "msg_playwright_sent";
const INBOX_SUBJECT = "Playwright Test Message";

// Every account here reads the same seeded mailbox, so each message is listed
// once per account included in All inboxes, marked with its account.
test("merges Drafts, Sent and Starred from every included account, each row acting in its own account", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { emailAccountId } = await openMail(page);
  const primaryEmail = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!primaryEmail) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const second = await createSecondEmailAccount(emailAccountId);
  const excluded = await createSecondEmailAccount(emailAccountId);
  const subject = `All inboxes draft ${testInfo.retry}-${Date.now()}`;
  let draftId: string | undefined;
  const operations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/operations/"))
      operations.push(request.url());
  });

  try {
    await excludeFromAllInboxes(excluded.id);
    draftId = await createMailboxDraft(page, subject);

    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    const conversations = page.getByRole("listbox", { name: "Conversations" });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    const mailboxes = page.getByRole("navigation", { name: "Mailboxes" });

    await mailboxes
      .getByRole("link", { name: "Sent", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/all-inboxes\/sent(\?|$)/);
    const sentRows = conversationWithSubject(page, conversations, SENT_SUBJECT);
    // The second account was never opened in this browser; it syncs here.
    await expect(sentRows).toHaveCount(2, { timeout: 120_000 });
    await expect(
      sentRows.filter({ has: accountMarker(page, primaryEmail) }),
    ).toHaveCount(1);
    const secondSent = sentRows.filter({
      has: accountMarker(page, second.email),
    });
    await expect(secondSent).toHaveCount(1);
    await expect(accountMarker(conversations, excluded.email)).toHaveCount(0);
    await expect(
      conversationWithSubject(page, conversations, INBOX_SUBJECT),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-sent");

    // Starring from the merged list stars it in the row's account.
    await secondSent.getByRole("checkbox", { includeHidden: true }).click();
    operations.length = 0;
    await page.keyboard.press("s");
    await expect(
      secondSent.getByText("Starred conversation", { exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(() => operationAccounts(operations), { timeout: 60_000 })
      .toEqual([second.id]);
    await page.keyboard.press("Escape");

    // Gmail's g then s stays in All inboxes.
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await expect(page).toHaveURL(/\/all-inboxes\/starred(\?|$)/);
    await expect(
      conversationWithSubject(page, conversations, SENT_SUBJECT).filter({
        has: accountMarker(page, second.email),
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      conversationWithSubject(page, conversations, INBOX_SUBJECT),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-starred");

    await mailboxes
      .getByRole("link", { name: "Drafts", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/all-inboxes\/drafts(\?|$)/);
    const draftRows = conversationWithSubject(page, conversations, subject);
    await expect(draftRows).toHaveCount(2, { timeout: 60_000 });
    await expect(
      conversationWithSubject(page, conversations, SENT_SUBJECT),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-drafts");

    await draftRows.filter({ has: accountMarker(page, second.email) }).click();
    // All inboxes names the open thread's account by its position.
    await expect(page).toHaveURL(/[?&]account=[1-9]/);
    const editor = page.getByRole("textbox", { name: "Email message" });
    await expect(editor).toBeVisible({ timeout: 60_000 });
    const edit = ` Edited in All inboxes ${Date.now()}`;
    const saves: Request[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.postData()?.includes(edit))
        saves.push(request);
    });
    await editor.press("End");
    await editor.pressSequentially(edit);
    await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-open-draft");

    // The draft is saved as the account it belongs to.
    await expect
      .poll(() => saves.length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    for (const request of saves) {
      const savedAs =
        (await request.headerValue("x-email-account-id")) ?? request.url();
      expect(savedAs).toContain(second.id);
      expect(savedAs).not.toContain(emailAccountId);
    }

    // Scheduling it takes it out of the merged Drafts at once, so it can't be
    // opened and sent a second time; the other account's copy stays.
    await page.getByRole("button", { name: "Send later", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Send later" })
      .getByRole("button", { name: /Tomorrow morning/ })
      .click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Back to the list without navigating to Drafts again: it must drop the
    // draft by itself, not on a remount's revalidation.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/all-inboxes\/drafts(\?|$)/);
    await expect(
      draftRows.filter({ has: accountMarker(page, primaryEmail) }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      draftRows.filter({ has: accountMarker(page, second.email) }),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      draftRows.filter({ has: accountMarker(page, primaryEmail) }),
    ).toHaveCount(1);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "all-inboxes-draft-scheduled",
    );
  } finally {
    await cancelPendingScheduledEmails(second.id).catch(() => undefined);
    await unstarSentMessage(page).catch(() => undefined);
    if (draftId) await deleteMailboxDraft(page, draftId).catch(() => undefined);
    await deleteSecondEmailAccount(excluded.accountId);
    await deleteSecondEmailAccount(second.accountId);
  }
});

function accountMarker(scope: Page | Locator, email: string) {
  return scope.getByRole("img", { name: `Inbox: ${email}` });
}

function operationAccounts(urls: string[]) {
  const accounts = urls.map((url) =>
    decodeURIComponent(
      /\/api\/mail\/v1\/accounts\/([^/]+)\/operations\//.exec(url)?.[1] ?? "",
    ),
  );
  return [...new Set(accounts)];
}

async function excludeFromAllInboxes(emailAccountId: string) {
  await withClient((client) =>
    client.query(
      `UPDATE "EmailAccount" SET "includeInAllAccounts" = false WHERE id = $1`,
      [emailAccountId],
    ),
  );
}

async function cancelPendingScheduledEmails(emailAccountId: string) {
  await withClient((client) =>
    client.query(
      `DELETE FROM "ScheduledEmail" WHERE "emailAccountId" = $1 AND status = 'PENDING'`,
      [emailAccountId],
    ),
  );
}

async function providerHeaders() {
  return {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
    "content-type": "application/json",
  };
}

async function createMailboxDraft(page: Page, subject: string) {
  const headers = await providerHeaders();
  if (isMicrosoftPlaywright()) {
    const created = await page.request.post(
      `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages`,
      {
        headers,
        data: {
          subject,
          body: { contentType: "text", content: "A draft for every account." },
          toRecipients: [{ emailAddress: { address: "jordan@example.com" } }],
        },
      },
    );
    expect(created.ok(), await created.text()).toBe(true);
    return ((await created.json()) as { id: string }).id;
  }
  const created = await page.request.post(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/drafts`,
    {
      headers,
      data: {
        message: {
          to: "Jordan Example <jordan@example.com>",
          subject,
          body_text: "A draft for every account.",
        },
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function deleteMailboxDraft(page: Page, draftId: string) {
  const headers = await providerHeaders();
  await page.request.delete(
    isMicrosoftPlaywright()
      ? `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${draftId}`
      : `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/drafts/${draftId}`,
    { headers },
  );
}

// Later specs expect the seeded sent message unstarred.
async function unstarSentMessage(page: Page) {
  const headers = await providerHeaders();
  if (isMicrosoftPlaywright()) {
    await page.request.patch(
      `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${SENT_MESSAGE_ID}`,
      { headers, data: { flag: { flagStatus: "notFlagged" } } },
    );
    return;
  }
  await page.request.post(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${SENT_MESSAGE_ID}/modify`,
    { headers, data: { removeLabelIds: ["STARRED"] } },
  );
}
