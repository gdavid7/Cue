import { expect, type Page, type Request } from "@playwright/test";
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
  UNDO_WINDOW_SEND_TIMEOUT_MS,
} from "./mail-test-helpers";

test("replies all from the account that owns the thread, leaving out the user's other address", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Seeds the message through the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const primaryEmail = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!primaryEmail) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `Owning account reply ${testInfo.retry}-${Date.now()}`;

  try {
    await insertMessage(page, {
      from: "Dana Example <dana@example.com>",
      to: primaryEmail,
      cc: `${secondAccount.email}, Alex Kim <alex@example.com>`,
      subject,
    });

    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    const conversations = page.getByRole("listbox", { name: "Conversations" });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    const secondAccountRow = conversationWithSubject(
      page,
      conversations,
      subject,
    ).filter({
      has: page.getByRole("img", { name: `Inbox: ${secondAccount.email}` }),
    });
    await expect(secondAccountRow).toBeVisible({ timeout: 60_000 });
    await secondAccountRow.click();
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();

    await page.getByRole("button", { name: "Reply all", exact: true }).click();
    const replyEditor = page.getByRole("textbox", { name: "Email message" });
    await expect(replyEditor).toBeVisible({ timeout: 60_000 });
    const composer = page.locator("form").filter({ has: replyEditor });
    // The summary names every connected address as "me", so neither shows.
    await expect(composer).toContainText(/alex/i);
    await expect(composer).not.toContainText(secondAccount.email);
    await expect(composer).not.toContainText(primaryEmail);
    await capturePlaywrightCheckpoint(page, testInfo, "reply-all-recipients");

    const replyBody = `Reply from the owning account ${Date.now()}`;
    await replyEditor.pressSequentially(replyBody);
    const sends: Request[] = [];
    const executedOperations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.postData()?.includes(replyBody))
        sends.push(request);
    });
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.method() === "POST" &&
        request.url().includes("/operations/") &&
        sends.some((send) => request.url().startsWith(send.url())) &&
        response.ok()
      )
        executedOperations.push(request.url());
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The reply's operation is created and, after the undo window, run.
    await expect
      .poll(() => executedOperations.length, {
        timeout: UNDO_WINDOW_SEND_TIMEOUT_MS + 30_000,
      })
      .toBeGreaterThan(0);
    for (const url of executedOperations)
      expect(url).toContain(`/accounts/${secondAccount.id}/`);
    // Every request that carried the reply went out as the second account.
    expect(sends.length).toBeGreaterThan(0);
    for (const request of sends) {
      expect((await request.response())?.ok()).toBe(true);
      const sentAs =
        (await request.headerValue("x-email-account-id")) ?? request.url();
      expect(sentAs).toContain(secondAccount.id);
      expect(sentAs).not.toContain(emailAccountId);
    }
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

async function insertMessage(
  page: Page,
  input: { from: string; to: string; cc: string; subject: string },
) {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const inserted = await page.request.post(
    `${baseUrl}/gmail/v1/users/me/messages`,
    {
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
        "content-type": "application/json",
      },
      data: {
        ...input,
        body_text: "Can you both take a look?",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
}
