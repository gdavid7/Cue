import { expect, type Page } from "@playwright/test";
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
  openThreadIdFromUrl,
  readLatestMailMutation,
  readProviderAccessToken,
} from "./mail-test-helpers";

const THREAD_ID = "thr_playwright_reader_html";

test("opens a sender's card and goes from it to a past conversation", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await sender.click();
  const card = page.getByTestId("person-card");
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("heading", { name: "Dana Example", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("dana@example.com", { exact: true }),
  ).toBeVisible();
  const recent = card
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Recent conversations" }),
    })
    .getByRole("button");
  // Dana has written about more than the open conversation, which the card
  // leaves out.
  await expect(recent.first()).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-light");

  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-dark");
  await page.emulateMedia({ colorScheme: "light" });

  const subject = (
    await recent.first().locator("span.truncate").first().textContent()
  )?.trim();
  expect(subject).toBeTruthy();
  await recent.first().click();

  await expect(card).toBeHidden();
  await expect.poll(() => openThreadIdFromUrl(page.url())).not.toBe(THREAD_ID);
  await expect(
    page.getByRole("heading", { name: subject, exact: true }).first(),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-opened-past");
});

test("opens the sender's card from the keyboard and keeps focus in it", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await page.keyboard.press("i");
  const card = page.getByTestId("person-card");
  await expect(card).toBeVisible();
  const focusInCard = () =>
    card.evaluate((element) => element.contains(document.activeElement));
  await expect.poll(focusInCard).toBe(true);
  for (let step = 0; step < 12; step++) await page.keyboard.press("Tab");
  expect(await focusInCard()).toBe(true);

  // Mail keys belong to the card while it is open: `e` doesn't archive.
  await page.keyboard.press("e");
  await expect(card).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // The reader stays on the conversation, with focus back on the name, and
  // the `e` pressed in the card queued no archive.
  expect(openThreadIdFromUrl(page.url())).toBe(THREAD_ID);
  await expect(sender).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Reader Html Message", exact: true }),
  ).toBeVisible();
  expect(
    await readLatestMailMutation(page, {
      emailAccountId,
      kind: "archive",
      threadId: THREAD_ID,
    }),
  ).toBeUndefined();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-closed");
});

test("shows the card as a sheet on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { emailAccountId } = await openMail(page);
  const sender = await openThread(page, emailAccountId);

  await sender.click();
  const sheet = page.getByRole("dialog", { name: "Dana Example" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "New message" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "person-card-mobile");

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("in All inboxes, writes to them from the account the message came to", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Seeds the message through the Gmail emulator.",
  );
  test.setTimeout(180_000);
  const { emailAccountId } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `Person card compose account ${testInfo.retry}-${Date.now()}`;

  try {
    await insertMessage(page, {
      from: "Dana Example <dana@example.com>",
      to: secondAccount.email,
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

    await page
      .locator("li[data-thread-message-id]")
      .getByRole("button", { name: "Dana Example", exact: true })
      .click();
    const card = page.getByTestId("person-card");
    await card.getByRole("button", { name: "New message" }).click();

    // The account in the address is the primary one; the message came to the
    // second.
    const dialog = page.getByRole("dialog", { name: "New Message" });
    await expect(dialog.getByRole("combobox", { name: "From" })).toContainText(
      secondAccount.email,
      { timeout: 60_000 },
    );
    await expect(dialog).toContainText(/dana/i);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "person-card-compose-from",
    );
    await dialog.getByRole("button", { name: "Close compose" }).click();
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

async function insertMessage(
  page: Page,
  input: { from: string; to: string; subject: string },
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
        body_text: "Could you send me the notes?",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
}

async function openThread(page: Page, emailAccountId: string) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${THREAD_ID}`, {
    waitUntil: "domcontentloaded",
  });
  const message = page.locator(
    'li[data-thread-message-id="msg_playwright_reader_html"]',
  );
  await expect(message).toBeVisible({ timeout: 60_000 });
  const sender = message.getByRole("button", {
    name: "Dana Example",
    exact: true,
  });
  await expect(sender).toBeVisible();
  return sender;
}
