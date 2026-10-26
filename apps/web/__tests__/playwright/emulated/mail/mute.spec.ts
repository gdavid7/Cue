import { expect, type Locator, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  deleteProviderMessage,
  insertInboxThread,
  insertReply,
  messageInInbox,
  openMail,
  openMailboxFromSidebar,
  providerConversationInInbox,
  readProviderAccessToken,
  requestMailSync,
  setPremium,
  withClient,
} from "./mail-test-helpers";

const SENDER = { name: "Wren Example", address: "wren@example.com" };

let emailAccountId: string | undefined;
let threadIds: string[] = [];
let messageIds: string[] = [];

test.afterEach(async ({ page }) => {
  const token = await readProviderAccessToken();
  if (emailAccountId) {
    const account = emailAccountId;
    await withClient((client) =>
      client.query(
        `DELETE FROM "MutedThread" WHERE "emailAccountId" = $1 AND "threadId" = ANY($2)`,
        [account, threadIds],
      ),
    );
  }
  for (const messageId of messageIds) {
    await deleteProviderMessage(page, token, messageId).catch(() => undefined);
  }
  emailAccountId = undefined;
  threadIds = [];
  messageIds = [];
});

test("muting from More actions archives the conversation and lists it under Muted", async ({
  page,
}, testInfo) => {
  const { conversations, subject, threadId } = await openNewConversation(
    page,
    "menu",
  );
  const row = conversationWithSubject(page, conversations, subject);

  await row.click();
  await page.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: /^Mute/ }).click();

  await expectMuted(page, { conversations, subject, threadId });
  await openMailboxFromSidebar(page, "Muted");
  await expect(
    page
      .getByRole("list", { name: "Muted conversations" })
      .getByText(subject, { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "mute-menu-muted-view");
});

test("the m key mutes the selected conversation", async ({ page }) => {
  const { conversations, subject, threadId } = await openNewConversation(
    page,
    "key",
  );
  const row = conversationWithSubject(page, conversations, subject);

  await row.getByRole("checkbox", { includeHidden: true }).click();
  await page.keyboard.press("m");

  await expectMuted(page, { conversations, subject, threadId });
});

test("undoing a mute brings the conversation back to the inbox", async ({
  page,
}, testInfo) => {
  const { conversations, subject, threadId } = await openNewConversation(
    page,
    "undo",
  );
  const row = conversationWithSubject(page, conversations, subject);

  await row.getByRole("checkbox", { includeHidden: true }).click();
  await page.keyboard.press("m");
  const notifications = page.getByRole("region", {
    name: "Notifications alt+T",
  });
  await expect(notifications.getByText(/^Muted/)).toBeVisible();
  await notifications.getByRole("button", { name: /^Undo/ }).click();

  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect
    .poll(() => providerConversationInInbox(threadId), { timeout: 60_000 })
    .toBe(true);
  await expect.poll(() => mutedCount(threadId), { timeout: 30_000 }).toBe(0);
  await capturePlaywrightCheckpoint(page, testInfo, "mute-undone-inbox");

  await openMailboxFromSidebar(page, "Muted");
  await expect(
    page
      .getByRole("list", { name: "Muted conversations" })
      .or(page.getByText(/^Nothing muted\./)),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(subject, { exact: true })).toHaveCount(0);
});

// Accounts without premium AI and rules or filing get no webhook processing;
// their mail reaches Cue through the mail engine's sync. Taking the premium
// away and delivering no webhook leaves only that path to archive the reply.
test("a new reply in a muted conversation stays out of the inbox, through mail sync", async ({
  page,
}, testInfo) => {
  const { emailAccountId: account } = await openMail(page);
  emailAccountId = account;
  const original = await readPremium(account);
  const token = await readProviderAccessToken();
  const subject = `Mute reply ${Date.now()}`;

  try {
    await setPremium(account, null);
    const thread = await insertInboxThread(page, {
      subject,
      body: "Weekly thread",
      from: SENDER,
    });
    threadIds.push(thread.threadId);
    messageIds.push(thread.messageId);

    const conversations = (await openMail(page)).conversations;
    await requestMailSync(page);
    const row = conversationWithSubject(page, conversations, subject);
    await expect(row).toHaveCount(1, { timeout: 60_000 });

    await row.getByRole("checkbox", { includeHidden: true }).click();
    await page.keyboard.press("m");
    await expect(row).toHaveCount(0);
    await expect
      .poll(() => mutedCount(thread.threadId), { timeout: 30_000 })
      .toBe(1);
    await expect
      .poll(() => messageInInbox(page, token, thread.messageId), {
        timeout: 60_000,
      })
      .toBe(false);

    // The reply has to arrive after the mute to count.
    const mutedAt = await readMutedAt(account, thread.threadId);
    await expect.poll(() => Date.now() > mutedAt + 1000).toBe(true);
    const replyId = await insertReply(
      page,
      token,
      {
        threadId: thread.threadId,
        messageId: thread.messageId,
        subject: `Re: ${subject}`,
      },
      SENDER,
    );
    messageIds.push(replyId);
    expect(await messageInInbox(page, token, replyId)).toBe(true);

    // No webhook: opening the mailbox syncs the reply in. Each reload
    // leaves the last sync time to finish, since leaving cancels it.
    await expect
      .poll(
        async () => {
          await openMail(page);
          return messageInInbox(page, token, replyId);
        },
        { timeout: 180_000, intervals: [15_000] },
      )
      .toBe(false);
    const reopened = await openMail(page);
    await expect(
      conversationWithSubject(page, reopened.conversations, subject).or(
        conversationWithSubject(page, reopened.conversations, `Re: ${subject}`),
      ),
    ).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "mute-reply-stays-out");
  } finally {
    await setPremium(account, original);
  }
});

test("unmuting removes it from Muted and leaves it archived", async ({
  page,
}, testInfo) => {
  const { conversations, subject, threadId } = await openNewConversation(
    page,
    "unmute",
  );
  const row = conversationWithSubject(page, conversations, subject);

  await row.getByRole("checkbox", { includeHidden: true }).click();
  await page.keyboard.press("m");
  await expectMuted(page, { conversations, subject, threadId });

  await openMailboxFromSidebar(page, "Muted");
  const mutedList = page.getByRole("list", { name: "Muted conversations" });
  const mutedRow = mutedList
    .getByRole("listitem")
    .filter({ has: page.getByText(subject, { exact: true }) });
  await expect(mutedRow).toHaveCount(1, { timeout: 60_000 });
  await mutedRow.getByRole("button", { name: "Unmute" }).click();

  await expect(mutedRow).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => mutedCount(threadId)).toBe(0);
  await capturePlaywrightCheckpoint(page, testInfo, "mute-unmuted-view");
  expect(await providerConversationInInbox(threadId)).toBe(false);

  const reopened = await openMail(page);
  await expect(
    conversationWithSubject(page, reopened.conversations, subject),
  ).toHaveCount(0);
});

async function openNewConversation(page: Page, label: string) {
  const mail = await openMail(page);
  emailAccountId = mail.emailAccountId;
  const subject = `Mute ${label} ${Date.now()}`;
  const thread = await insertInboxThread(page, {
    subject,
    body: "Weekly thread",
    from: SENDER,
  });
  threadIds.push(thread.threadId);
  messageIds.push(thread.messageId);
  await requestMailSync(page);
  await expect(
    conversationWithSubject(page, mail.conversations, subject),
  ).toHaveCount(1, { timeout: 60_000 });
  return { ...mail, subject, threadId: thread.threadId };
}

/** The row leaves the inbox, the provider archives it, and Cue records the mute. */
async function expectMuted(
  page: Page,
  input: {
    conversations: Locator;
    subject: string;
    threadId: string;
  },
) {
  await expect(
    conversationWithSubject(page, input.conversations, input.subject),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByText(/^Muted/),
  ).toBeVisible();
  await expect
    .poll(() => providerConversationInInbox(input.threadId), {
      timeout: 60_000,
    })
    .toBe(false);
  await expect
    .poll(() => mutedCount(input.threadId), { timeout: 30_000 })
    .toBe(1);
}

async function mutedCount(threadId: string) {
  const account = emailAccountId;
  if (!account) throw new Error("No account is open");
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM "MutedThread" WHERE "emailAccountId" = $1 AND "threadId" = $2`,
      [account, threadId],
    );
    return result.rowCount ?? 0;
  });
}

async function readMutedAt(account: string, threadId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ ms: string }>(
      `SELECT EXTRACT(EPOCH FROM "createdAt") * 1000 AS ms FROM "MutedThread"
        WHERE "emailAccountId" = $1 AND "threadId" = $2`,
      [account, threadId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("The conversation isn't muted");
    return Number(row.ms);
  });
}

async function readPremium(account: string) {
  return withClient(async (client) => {
    const result = await client.query<{ premiumId: string | null }>(
      `SELECT app_user."premiumId" FROM "EmailAccount" email
        JOIN "User" app_user ON app_user.id = email."userId"
        WHERE email.id = $1`,
      [account],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Missing emulator account");
    return row.premiumId;
  });
}
