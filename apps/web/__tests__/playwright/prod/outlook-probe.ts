import { expect, type Page } from "@playwright/test";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { parseMailPath } from "@/utils/mail-url";
import { assertOnlySelfRecipients, guardRecipients } from "./qa-session";

// Steps on the Outlook QA mailbox that both robots share. The Outlook mailbox
// is linked to the QA user next to its Gmail one, so the robot reaches it
// through the same email-code session; probes only ever go between the two
// QA addresses.

/** The QA user's mailbox for `email` in Cue, or null when it is not linked. */
export async function findMailAccount(page: Page, email: string) {
  const response = await page.request.get("/api/user/email-accounts");
  expect(response.ok(), "email accounts load").toBe(true);
  const { emailAccounts }: GetEmailAccountsResponse = await response.json();
  const index = emailAccounts.findIndex(
    (account) => account.email.toLowerCase() === email.toLowerCase(),
  );
  const match = emailAccounts[index];
  if (!match) return null;
  return {
    id: match.id,
    index,
    disconnected: Boolean(match.account.disconnectedAt),
  };
}

/**
 * From the open probe thread, replies to the Gmail QA account only and waits
 * until the send has left Cue's undo window.
 */
export async function replyToGmailQa(
  page: Page,
  { gmail, outlook, token }: { gmail: string; outlook: string; token: string },
) {
  const message = page.locator("[data-thread-message-id]").last();
  await message.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = message.getByRole("textbox", { name: "Email message" });
  await expect(editor).toBeVisible();
  await assertOnlySelfRecipients(page, gmail);
  await editor.pressSequentially(token);
  const releaseGuard = await guardRecipients(page, [gmail, outlook]);
  try {
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor, "the composer closes after Send").toHaveCount(0);
    await expect(
      page.getByText("Sending…", { exact: true }),
      "the send leaves the undo window",
    ).toHaveCount(0, { timeout: 90_000 });
  } finally {
    await releaseGuard();
  }
}

/** Moves the open probe thread to Deleted Items, so the Outlook box stays small. */
export async function trashOpenThread(page: Page, accountId: string) {
  const threadId = parseMailPath(new URL(page.url()).pathname)?.threadId;
  if (!threadId) return;
  await page.request.post(
    `/api/threads/${encodeURIComponent(threadId)}/trash`,
    { headers: { "X-Email-Account-ID": accountId } },
  );
}
