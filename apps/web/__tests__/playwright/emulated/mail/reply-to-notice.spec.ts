import { expect } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  clearWorkflowMailboxDrafts,
  insertInboxThread,
  openMail,
  readLatestMailMutation,
  readProviderAccessToken,
  requestMailSync,
  UNDO_WINDOW_SEND_TIMEOUT_MS,
} from "./mail-test-helpers";

const SENDER = { name: "Ana Ruiz", address: "ana@supplier.test" };
const REPLY_TO = "billing@payments-desk.test";
const NOTICE = `Goes to ${REPLY_TO}, set by the sender's Reply-To`;
const SWAP = "Reply to Ana Ruiz instead";

test.beforeEach(async ({ page }) => {
  await clearWorkflowMailboxDrafts(page);
});

test("says a reply goes to another domain's Reply-To, and replies to the sender instead", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { emailAccountId } = await openMail(page);
  const subject = `Reply-To notice ${testInfo.retry}-${Date.now()}`;
  const { threadId, messageId } = await insertInboxThread(page, {
    subject,
    body: "Our bank details changed, please confirm the new invoice.",
    from: SENDER,
    replyTo: REPLY_TO,
    // Someone else on the message, so Reply all is offered.
    cc: "sam@supplier.test",
  });
  await requestMailSync(page);
  await page.goto(`/${emailAccountId}/mail?thread-id=${threadId}`);
  const message = page.locator(`[data-thread-message-id="${messageId}"]`);
  await expect(message).toBeVisible({ timeout: 60_000 });

  await message.getByRole("button", { name: "Reply all", exact: true }).click();
  const notice = message.getByText(NOTICE, { exact: true });
  // The line reads the To chips, so Reply all went to the Reply-To in place of
  // the sender, as in Gmail.
  await expect(notice).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "reply-to-notice-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "reply-to-notice-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await message.getByRole("button", { name: SWAP }).click();
  await expect(notice).toHaveCount(0);
  await expect(message.getByRole("button", { name: SWAP })).toHaveCount(0);
  await message.getByRole("button", { name: /^(Reply|Draft) to / }).click();
  await expect(
    message.getByRole("button", { name: `Remove ${SENDER.address}` }),
  ).toBeVisible();
  await expect(
    message.getByRole("button", { name: `Remove ${REPLY_TO}` }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "reply-to-swapped");

  const body = `Replying to the sender. ${testInfo.retry}-${Date.now()}`;
  const editor = message.getByRole("textbox", { name: "Email message" });
  await editor.pressSequentially(body);
  await expect(editor).toContainText(body);
  await message.getByRole("button", { name: "Send", exact: true }).click();

  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId,
        }),
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS + 30_000 },
    )
    .toMatchObject({ status: "succeeded" });
  const sentTo = await readSentTo({ threadId, subject });
  expect(sentTo).toContain(SENDER.address);
  expect(sentTo).not.toContain(REPLY_TO);
});

// The thread is new to this test, so its one sent message is the reply.
async function readSentTo({
  threadId,
  subject,
}: {
  threadId: string;
  subject: string;
}) {
  if (isMicrosoftPlaywright()) return readOutlookSentTo(subject);
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const response = await fetch(
    `${baseUrl}/gmail/v1/users/me/threads/${threadId}?format=full`,
    {
      headers: { Authorization: `Bearer ${await readProviderAccessToken()}` },
    },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  const thread = JSON.parse(text) as {
    messages: {
      labelIds?: string[];
      payload?: { headers?: { name: string; value: string }[] };
    }[];
  };
  const sent = thread.messages.find((item) => item.labelIds?.includes("SENT"));
  expect(sent, "the sent reply is in the thread").toBeDefined();
  return (
    sent?.payload?.headers?.find((header) => header.name.toLowerCase() === "to")
      ?.value ?? ""
  ).toLowerCase();
}

async function readOutlookSentTo(subject: string) {
  const baseUrl = process.env.MICROSOFT_BASE_URL;
  if (!baseUrl) throw new Error("MICROSOFT_BASE_URL is missing");
  const response = await fetch(
    `${baseUrl}/v1.0/me/mailFolders/sentitems/messages?$top=100`,
    {
      headers: { Authorization: `Bearer ${await readProviderAccessToken()}` },
    },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  const { value } = JSON.parse(text) as {
    value: {
      subject?: string;
      toRecipients?: { emailAddress?: { address?: string } }[];
    }[];
  };
  const sent = value.find((item) => item.subject?.includes(subject));
  expect(sent, "the sent reply is in Sent Items").toBeDefined();
  return (sent?.toRecipients ?? [])
    .map((recipient) => recipient.emailAddress?.address ?? "")
    .join(", ")
    .toLowerCase();
}
