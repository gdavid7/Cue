import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  insertMessageWithAttachments,
  removeMessage,
  SENDER,
} from "./attachment-message-helpers";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  openMail,
  openThreadIdFromUrl,
  requestMailSync,
} from "./mail-test-helpers";

// A real PDF, so the preview renders rather than reporting a broken file.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type Seeded = {
  token: string;
  subject: string;
  pdf: string;
  sheet: string;
  logo: string;
  threadId: string;
  messageId: string;
};

let seeded: Seeded | undefined;

test.beforeEach(async ({ page }, testInfo) => {
  const token = `f${testInfo.retry}${Date.now().toString(36)}`;
  const file = (name: string) => `${name}-${token}`;
  const files = {
    pdf: `${file("contract")}.pdf`,
    sheet: `${file("budget")}.xlsx`,
    logo: `${file("logo")}.png`,
  };
  const subject = `Files view ${token}`;
  seeded = {
    token,
    subject,
    ...files,
    ...(await insertMessageWithAttachments(page, {
      subject,
      html: '<p>The files are attached.</p><img src="cid:files-logo">',
      attachments: [
        { name: files.pdf, type: "application/pdf", bytes: PDF, inline: false },
        {
          name: files.sheet,
          // Senders often label files generically; the name says what it is.
          type: "application/octet-stream",
          bytes: Buffer.from("PK\u0003\u0004sheet"),
          inline: false,
        },
        { name: files.logo, type: "image/png", bytes: PNG, inline: true },
      ],
    })),
  };
});

test.afterEach(async ({ page }) => {
  // Other specs share the mailbox.
  if (seeded) await removeMessage(page, seeded.messageId);
  seeded = undefined;
});

test("lists a message's files from the sidebar and filters them by type, name and sender", async ({
  page,
}, testInfo) => {
  const files = await openFiles(page);
  const { pdf, sheet, logo, token, subject } = requireSeeded();

  await expect(page).toHaveURL(/\/mail\/u\/\d+\/files(\?|$)/);
  await expect(row(files, pdf)).toBeVisible();
  await expect(row(files, sheet)).toBeVisible();
  // The Outlook emulator sends created mail from the account itself.
  const senderName = isMicrosoftPlaywright()
    ? await senderOf(row(files, pdf))
    : SENDER.name;
  await expect(row(files, pdf)).toContainText(senderName);
  await expect(row(files, pdf)).toContainText(subject);
  // A signature logo is part of the message, not one of its files.
  await expect(row(files, logo)).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-desktop");

  await page
    .getByRole("group", { name: "File type" })
    .getByRole("button", { name: "Spreadsheets", exact: true })
    .click();
  await expect(row(files, sheet)).toBeVisible();
  await expect(row(files, pdf)).toHaveCount(0);
  await page
    .getByRole("group", { name: "File type" })
    .getByRole("button", { name: "All", exact: true })
    .click();

  const search = page.getByRole("searchbox", { name: "Search file names" });
  await search.fill(`contract ${token}`);
  await expect(row(files, pdf)).toBeVisible();
  await expect(row(files, sheet)).toHaveCount(0);
  await search.fill("");

  await page.getByRole("combobox", { name: "Filter by sender" }).click();
  await page.getByPlaceholder("Search senders").fill(senderName);
  await page
    .getByRole("option", { name: new RegExp(escapeRegExp(senderName)) })
    .first()
    .click();
  await expect(row(files, pdf)).toBeVisible();
  await expect(
    files.getByRole("listitem").filter({ hasNotText: senderName }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-filtered");

  await page
    .getByRole("button", { name: `From ${senderName}. Clear sender filter` })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Filter by sender" }),
  ).toBeVisible();
});

test("previews a file, downloads it, and opens its conversation", async ({
  page,
}, testInfo) => {
  const files = await openFiles(page);
  const { pdf, subject, threadId } = requireSeeded();

  await row(files, pdf)
    .getByRole("button", { name: `Preview ${pdf}` })
    .click();
  const dialog = page.getByRole("dialog", { name: pdf });
  await expect(dialog.locator(`iframe[title="${pdf}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-preview");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const download = page.waitForEvent("download");
  await row(files, pdf)
    .getByRole("button", { name: `Download ${pdf}` })
    .click();
  expect((await download).suggestedFilename()).toBe(pdf);

  await row(files, pdf)
    .getByRole("button", { name: `Open conversation for ${pdf}` })
    .click();
  await expect(
    page.getByRole("heading", { name: subject, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(openThreadIdFromUrl(page.url())).toBe(threadId);
  await expect(page).toHaveURL(/\/files\//);
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-conversation");
});

test("attaches a file from mail in the composer without a download", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await openFiles(page);
  const { pdf, token } = requireSeeded();

  await page.getByRole("button", { name: /^Compose/ }).click();
  const compose = page.getByRole("dialog", { name: "New Message" });
  await compose
    .getByRole("combobox", { name: "To", exact: true })
    .fill(SENDER.address);
  await page.keyboard.press("Enter");
  await compose.getByRole("button", { name: "Attach from mail" }).click();

  const picker = page.getByRole("dialog", { name: "Attach from mail" });
  const option = picker.getByRole("option", {
    name: new RegExp(escapeRegExp(pdf)),
  });
  await expect(option).toBeVisible({ timeout: 60_000 });
  // The Outlook emulator sends created mail from the account itself, which
  // isn't a recipient, so only Gmail lists the recipient's own files first.
  if (!isMicrosoftPlaywright())
    await expect(
      picker
        // The recipient reads by name once the address matches a contact.
        .getByRole("group", {
          name: new RegExp(
            `^Files from (${SENDER.name}|${escapeRegExp(SENDER.address)})$`,
          ),
        })
        .getByRole("option", { name: new RegExp(escapeRegExp(pdf)) }),
    ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "attach-from-mail-picker");

  await picker
    .getByRole("combobox", { name: "Search file names" })
    .fill(`contract ${token}`);
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(picker).toBeHidden({ timeout: 60_000 });
  const attachments = compose.getByRole("list", { name: "Attachments" });
  await expect(attachments).toContainText(pdf);
  await expect(attachments.locator("li[aria-busy]")).toHaveCount(0, {
    timeout: 90_000,
  });
  await capturePlaywrightCheckpoint(page, testInfo, "attach-from-mail-chip");

  await compose.getByRole("button", { name: "Discard draft" }).click();
  await expect(compose).toBeHidden();
});

test("fits a phone screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMail(page);
  const { pdf } = requireSeeded();
  await requestMailSync(page);
  const accountIndex = page.url().match(/\/mail\/u\/(\d+)/)?.[1];
  expect(accountIndex).toBeDefined();
  await page.goto(`/mail/u/${accountIndex}/files`, {
    waitUntil: "domcontentloaded",
  });
  const files = page.getByRole("list", { name: "Files" });
  await expect(row(files, pdf)).toBeVisible({ timeout: 60_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(
    row(files, pdf).getByRole("button", { name: `Download ${pdf}` }),
  ).toBeInViewport();
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-phone");

  await row(files, pdf)
    .getByRole("button", { name: `Preview ${pdf}` })
    .click();
  await expect(page.getByRole("dialog", { name: pdf })).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "files-view-phone-preview");
});

test("in All inboxes, lists every account's files, each naming its account", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { emailAccountId } = await openMail(page);
  const { pdf } = requireSeeded();
  // Reads the primary's mailbox, so the file seeded there reached both.
  const second = await createSecondEmailAccount(emailAccountId, {
    mailbox: "primary",
  });
  try {
    await page.goto(`/${emailAccountId}/mail?accountScope=all`, {
      waitUntil: "domcontentloaded",
    });
    const mailboxes = page.getByRole("navigation", { name: "Mailboxes" });
    await mailboxes
      .getByRole("link", { name: "Files", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/all-inboxes\/files(\?|$)/);
    const files = page.getByRole("list", { name: "Files" });
    // Both accounts read the same seeded mailbox, so the file is listed once
    // for each; the second account was never opened here and syncs now.
    await expect(row(files, pdf)).toHaveCount(2, { timeout: 180_000 });
    await expect(
      row(files, pdf).filter({
        has: page.getByRole("img", { name: new RegExp(second.email) }),
      }),
    ).toHaveCount(1);
    await capturePlaywrightCheckpoint(page, testInfo, "files-view-all-inboxes");
  } finally {
    await deleteSecondEmailAccount(second.accountId);
  }
});

async function openFiles(page: Page) {
  await openMail(page);
  await requestMailSync(page);
  await page
    .getByRole("navigation", { name: "Mailboxes" })
    .getByRole("link", { name: "Files", exact: true })
    .click();
  const files = page.getByRole("list", { name: "Files" });
  await expect(row(files, requireSeeded().pdf)).toBeVisible({
    timeout: 60_000,
  });
  return files;
}

/** The sender shown in a file's row, between its size and its subject. */
async function senderOf(fileRow: Locator) {
  const meta = await fileRow
    .getByRole("button", { name: /^Preview / })
    .locator("span.truncate")
    .last()
    .textContent();
  const sender = meta?.split(" · ")[1]?.trim();
  if (!sender) throw new Error("The row shows no sender");
  return sender;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function row(files: Locator, filename: string) {
  return files
    .getByRole("listitem")
    .filter({ has: files.page().getByText(filename, { exact: true }) });
}

function requireSeeded() {
  if (!seeded) throw new Error("No message was inserted");
  return seeded;
}
