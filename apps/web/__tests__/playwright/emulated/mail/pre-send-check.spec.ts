import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openSettings } from "../settings/settings-test-helpers";
import {
  clearWorkflowMailboxDrafts,
  openMail,
  readProviderAccessToken,
} from "./mail-test-helpers";

const PRE_SEND_CHECK_KEY = "cue.pre-send-check";

test.beforeEach(async ({ page }) => {
  await clearWorkflowMailboxDrafts(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    PRE_SEND_CHECK_KEY,
  );
});

test("asks before sending a message that mentions a missing attachment", async ({
  page,
}, testInfo) => {
  await openMail(page);
  const dialog = await composeMentioningAttachment(
    page,
    `Playwright Pre-send Check ${testInfo.retry}-${Date.now()}`,
  );
  const send = dialog.getByRole("button", { exact: true, name: "Send" });
  await send.click();

  const check = dialog.getByRole("group", { name: "Before you send" });
  await expect(check).toContainText(
    "The message mentions an attachment, but nothing is attached.",
  );
  const sendAnyway = check.getByRole("button", { name: "Send anyway" });
  await expect(sendAnyway).toBeFocused();
  await expect(
    check.getByRole("button", { name: "Attach files" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-check-shown");

  // Escape steps back to the draft without closing the composer.
  await page.keyboard.press("Escape");
  await expect(check).toBeHidden();
  await expect(dialog).toBeVisible();

  await send.click();
  await expect(sendAnyway).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByText("Sending…", { exact: true }),
  ).toBeVisible();
});

test("asks before sending a message with an unfilled placeholder and selects it", async ({
  page,
}, testInfo) => {
  await openMail(page);
  const dialog = await composeWithBody(
    page,
    `Playwright Pre-send Placeholder ${testInfo.retry}-${Date.now()}`,
    "Hi [Name], the review is on {{date}}.",
  );
  await dialog.getByRole("button", { exact: true, name: "Send" }).click();

  const check = dialog.getByRole("group", { name: "Before you send" });
  await expect(check).toContainText(
    "The message still has placeholders to fill in: [Name], {{date}}.",
  );
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-placeholders");

  await check.getByRole("button", { name: "Edit message" }).click();
  await expect(check).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[Name]");

  await page.keyboard.type("Sam");
  await dialog.getByRole("button", { exact: true, name: "Send" }).click();
  await expect(check).toContainText(
    "The message still has a placeholder to fill in: {{date}}.",
  );
});

test("sends straight away when the check is turned off in Settings", async ({
  page,
}, testInfo) => {
  await openSettings(page);
  const toggle = page.getByRole("switch", { name: "Check before sending" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-check-setting");

  await openMail(page);
  const dialog = await composeMentioningAttachment(
    page,
    `Playwright Pre-send Off ${testInfo.retry}-${Date.now()}`,
  );
  await dialog.getByRole("button", { exact: true, name: "Send" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Before you send" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByText("Sending…", { exact: true }),
  ).toBeVisible();
});

test("does not flag an earlier participant added to a reply-all", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The Outlook emulator stamps the signed-in user as sender, so a thread with other participants can't be seeded.",
  );
  const { emailAccountId } = await openMail(page);
  const subject = `Pre-send participants ${testInfo.retry}-${Date.now()}`;
  const earlier = await insertGmailMessage({
    from: "Dana Example <dana@example.com>",
    to: userEmail(),
    cc: "Casey Earlier <casey.earlier@example.com>",
    subject,
    minutesAgo: 20,
  });
  const latest = await insertGmailMessage({
    threadId: earlier.threadId,
    from: "Alex Latest <alex.latest@example.com>",
    to: userEmail(),
    cc: "Eli Latest <eli.latest@example.com>",
    subject,
    minutesAgo: 10,
  });

  const message = await openThreadMessage(page, emailAccountId, latest);
  await message.getByRole("button", { name: "Reply all", exact: true }).click();
  await expect(
    message.getByRole("button", { name: "Remove eli.latest@example.com" }),
  ).toBeVisible();
  // Casey is only on the first message, not the one being replied to.
  await addRecipient(message, "casey.earlier@example.com");
  const body = `Pre-send participants body ${testInfo.retry}-${Date.now()}`;
  const { sent } = await sendReply(page, message, body);

  expect(await sent).not.toBeNull();
  await expect(
    page.getByRole("group", { name: "Before you send" }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "pre-send-reply-all-participant",
  );
});

test("does not count an alias the user sent from earlier as a new recipient", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The Outlook emulator always sends as the signed-in user, so an alias can't be seeded.",
  );
  const { emailAccountId } = await openMail(page);
  const subject = `Pre-send alias ${testInfo.retry}-${Date.now()}`;
  const aliasAddress = "me.alias@example.com";
  const sentEarlier = await insertGmailMessage({
    from: `Me Alias <${aliasAddress}>`,
    to: "Dana Example <dana@example.com>",
    subject,
    labelIds: ["SENT"],
    minutesAgo: 20,
  });
  const reply = await insertGmailMessage({
    threadId: sentEarlier.threadId,
    from: "Dana Example <dana@example.com>",
    to: userEmail(),
    subject,
    minutesAgo: 10,
  });

  const message = await openThreadMessage(page, emailAccountId, reply);
  await message.getByRole("button", { name: "Reply", exact: true }).click();
  await addRecipient(message, aliasAddress);
  const body = `Pre-send alias body ${testInfo.retry}-${Date.now()}`;
  const { sent } = await sendReply(page, message, body);

  expect(await sent).not.toBeNull();
  await expect(
    page.getByRole("group", { name: "Before you send" }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-reply-alias");
});

test("does not flag an earlier participant on a reopened draft reply", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The Outlook emulator stamps the signed-in user as sender, so a thread with other participants can't be seeded.",
  );
  const { emailAccountId } = await openMail(page);
  const subject = `Pre-send draft ${testInfo.retry}-${Date.now()}`;
  const earlier = await insertGmailMessage({
    from: "Dana Example <dana@example.com>",
    to: userEmail(),
    cc: "Casey Earlier <casey.earlier@example.com>",
    subject,
    minutesAgo: 20,
  });
  const latest = await insertGmailMessage({
    threadId: earlier.threadId,
    from: "Alex Latest <alex.latest@example.com>",
    to: userEmail(),
    subject,
    minutesAgo: 10,
  });
  const body = `PresendDraftBody${testInfo.retry}x${Date.now()}`;
  const created = await fetch(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/drafts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          threadId: earlier.threadId,
          to: "alex.latest@example.com, casey.earlier@example.com",
          subject: `Re: ${subject}`,
          body_text: body,
        },
      }),
    },
  );
  expect(created.ok, await created.text()).toBe(true);

  await openThreadMessage(page, emailAccountId, latest);
  const editor = page.getByRole("textbox", { name: "Email message" });
  await expect(editor).toContainText(body, { timeout: 60_000 });
  const sent = page
    .waitForRequest(
      (request) =>
        request.method() !== "GET" && !!request.postData()?.includes(body),
      { timeout: 90_000 },
    )
    .catch(() => null);
  await page
    .locator("form")
    .filter({ has: editor })
    .getByRole("button", { name: "Send", exact: true })
    .click();

  expect(await sent).not.toBeNull();
  await expect(
    page.getByRole("group", { name: "Before you send" }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "pre-send-reopened-draft");
});

test("warns about a recipient who was never on the thread", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const stranger = `stranger-${testInfo.retry}-${Date.now()}@example.com`;
  const body = `Pre-send stranger body ${testInfo.retry}-${Date.now()}`;
  let message: Locator;
  if (isMicrosoftPlaywright()) {
    // Reply to the seeded conversation, since another sender can't be seeded.
    await page.goto(`/${emailAccountId}/mail?thread-id=thr_playwright_reply`);
    message = page.locator('[data-thread-message-id="msg_playwright_reply"]');
    await expect(message).toBeVisible({ timeout: 60_000 });
  } else {
    const subject = `Pre-send stranger ${testInfo.retry}-${Date.now()}`;
    const earlier = await insertGmailMessage({
      from: "Dana Example <dana@example.com>",
      to: userEmail(),
      cc: "Casey Earlier <casey.earlier@example.com>",
      subject,
      minutesAgo: 20,
    });
    const latest = await insertGmailMessage({
      threadId: earlier.threadId,
      from: "Alex Latest <alex.latest@example.com>",
      to: userEmail(),
      subject,
      minutesAgo: 10,
    });
    message = await openThreadMessage(page, emailAccountId, latest);
  }

  await message.getByRole("button", { name: "Reply", exact: true }).click();
  await addRecipient(message, stranger);
  if (!isMicrosoftPlaywright())
    await addRecipient(message, "casey.earlier@example.com");
  await sendReply(page, message, body);

  const check = page.getByRole("group", { name: "Before you send" });
  await expect(check).toContainText(
    `${stranger} wasn't on the message you're replying to.`,
  );
  await expect(check).not.toContainText("casey.earlier@example.com");
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "pre-send-reply-new-recipient",
  );
});

function userEmail() {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  return email;
}

async function insertGmailMessage(input: {
  threadId?: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  labelIds?: string[];
  minutesAgo: number;
}) {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const { minutesAgo, labelIds, ...fields } = input;
  const response = await fetch(`${baseUrl}/gmail/v1/users/me/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await readProviderAccessToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...fields,
      body_text: "Pre-send check fixture message.",
      labelIds: labelIds ?? ["INBOX", "UNREAD"],
      internalDate: String(Date.now() - minutesAgo * 60_000),
    }),
  });
  expect(response.ok, await response.text()).toBe(true);
  return (await response.json()) as { id: string; threadId: string };
}

async function openThreadMessage(
  page: Page,
  emailAccountId: string,
  message: { id: string; threadId: string },
) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${message.threadId}`);
  const locator = page.locator(`[data-thread-message-id="${message.id}"]`);
  await expect(locator).toBeVisible({ timeout: 60_000 });
  return locator;
}

async function addRecipient(message: Locator, address: string) {
  const to = message.getByRole("combobox", { name: "To" });
  await to.fill(address);
  await to.press("Enter");
  await expect(
    message.getByRole("button", { name: `Remove ${address}` }),
  ).toBeVisible();
}

/** Types the reply and presses Send; `sent` resolves to the request that carried it, or null. */
async function sendReply(page: Page, message: Locator, body: string) {
  const editor = message.getByRole("textbox", { name: "Email message" });
  await editor.pressSequentially(body);
  await expect(editor).toContainText(body);
  const sent = page
    .waitForRequest(
      (request) =>
        request.method() !== "GET" && !!request.postData()?.includes(body),
      { timeout: 90_000 },
    )
    .catch(() => null);
  await message.getByRole("button", { name: "Send", exact: true }).click();
  return { sent };
}

async function composeMentioningAttachment(page: Page, subject: string) {
  return composeWithBody(page, subject, "The signed contract is attached.");
}

async function composeWithBody(page: Page, subject: string, body: string) {
  await page.getByRole("button", { name: /^Compose/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Message" });
  await dialog
    .getByRole("combobox", { name: "To" })
    .fill("recipient@example.com");
  await dialog.getByPlaceholder("Subject").fill(subject);
  const editor = dialog.locator("[contenteditable='true']");
  await editor.pressSequentially(body);
  await expect(editor).toContainText(body);
  return dialog;
}
