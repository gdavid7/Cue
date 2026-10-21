import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  openMail,
  openThreadIdFromUrl,
  readProviderAccessToken,
  requestMailSync,
} from "./mail-test-helpers";

const SENDER = { name: "Morgan Example", address: "morgan@example.com" };
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
    ...(await insertMessage(page, { subject, ...files })),
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
  const second = await createSecondEmailAccount(emailAccountId);
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

async function insertMessage(
  page: Page,
  input: { subject: string; pdf: string; sheet: string; logo: string },
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const attachments = [
    { name: input.pdf, type: "application/pdf", bytes: PDF, inline: false },
    {
      name: input.sheet,
      // Senders often label files generically; the name says what it is.
      type: "application/octet-stream",
      bytes: Buffer.from("PK\u0003\u0004sheet"),
      inline: false,
    },
    { name: input.logo, type: "image/png", bytes: PNG, inline: true },
  ];
  return isMicrosoftPlaywright()
    ? insertOutlookMessage(page, { email, subject: input.subject, attachments })
    : insertGmailMessage(page, { email, subject: input.subject, attachments });
}

type Attachment = {
  name: string;
  type: string;
  bytes: Buffer;
  inline: boolean;
};

async function insertGmailMessage(
  page: Page,
  {
    email,
    subject,
    attachments,
  }: { email: string; subject: string; attachments: Attachment[] },
) {
  const boundary = "playwright-files-boundary";
  const mime = [
    `From: ${SENDER.name} <${SENDER.address}>`,
    `To: ${email}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    '<p>The files are attached.</p><img src="cid:files-logo">',
    ...attachments.flatMap(({ name, type, bytes, inline }) => [
      `--${boundary}`,
      `Content-Type: ${type}; name="${name}"`,
      inline
        ? `Content-Disposition: inline; filename="${name}"`
        : `Content-Disposition: attachment; filename="${name}"`,
      ...(inline ? ["Content-ID: <files-logo>"] : []),
      "Content-Transfer-Encoding: base64",
      "",
      bytes.toString("base64"),
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await page.request.post(
    `${baseUrl("GOOGLE_BASE_URL")}/gmail/v1/users/me/messages`,
    {
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
        "content-type": "application/json",
      },
      data: {
        raw: Buffer.from(mime, "utf8").toString("base64url"),
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const message = (await response.json()) as { id: string; threadId: string };
  return { threadId: message.threadId, messageId: message.id };
}

async function insertOutlookMessage(
  page: Page,
  {
    email,
    subject,
    attachments,
  }: { email: string; subject: string; attachments: Attachment[] },
) {
  const outlook = baseUrl("MICROSOFT_BASE_URL");
  const created = await page.request.post(`${outlook}/v1.0/me/messages`, {
    headers: OUTLOOK_HEADERS,
    data: {
      subject,
      from: { emailAddress: SENDER },
      body: {
        contentType: "html",
        content: '<p>The files are attached.</p><img src="cid:files-logo">',
      },
      toRecipients: [{ emailAddress: { address: email } }],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  for (const { name, type, bytes, inline } of attachments) {
    const attached = await page.request.post(
      `${outlook}/v1.0/me/messages/${id}/attachments`,
      {
        headers: OUTLOOK_HEADERS,
        data: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name,
          contentType: type,
          contentBytes: bytes.toString("base64"),
          ...(inline ? { isInline: true, contentId: "files-logo" } : {}),
        },
      },
    );
    expect(attached.ok(), await attached.text()).toBe(true);
  }
  // Created messages start as drafts; moving one to the inbox delivers it.
  const moved = await page.request.post(
    `${outlook}/v1.0/me/messages/${id}/move`,
    {
      headers: OUTLOOK_HEADERS,
      data: { destinationId: "inbox" },
    },
  );
  expect(moved.ok(), await moved.text()).toBe(true);
  const message = (await moved.json()) as {
    id: string;
    conversationId: string;
  };
  return { threadId: message.conversationId, messageId: message.id };
}

async function removeMessage(page: Page, messageId: string) {
  if (isMicrosoftPlaywright()) {
    await page.request.delete(
      `${baseUrl("MICROSOFT_BASE_URL")}/v1.0/me/messages/${messageId}`,
      { headers: OUTLOOK_HEADERS },
    );
    return;
  }
  await page.request.post(
    `${baseUrl("GOOGLE_BASE_URL")}/gmail/v1/users/me/messages/${messageId}/trash`,
    { headers: { Authorization: `Bearer ${await readProviderAccessToken()}` } },
  );
}

const OUTLOOK_HEADERS = {
  Authorization: "Bearer playwright_microsoft_fixture_token",
  "content-type": "application/json",
};

function baseUrl(name: "GOOGLE_BASE_URL" | "MICROSOFT_BASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}
