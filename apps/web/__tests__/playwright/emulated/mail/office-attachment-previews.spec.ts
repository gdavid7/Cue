import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { readProviderAccessToken } from "./mail-test-helpers";

const FIXTURES = "__tests__/playwright/emulated/mail/fixtures";
const DOCX = "planning-notes.docx";
const XLSX = "team-budget.xlsx";
const PPTX = "launch-deck.pptx";
const TYPES: Record<string, string> = {
  [DOCX]:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  [XLSX]: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  [PPTX]:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

let inserted: { threadId: string; messageId: string } | undefined;
let subject = "";

test.beforeEach(async ({ page }, testInfo) => {
  subject = `Office previews ${testInfo.retry}-${Date.now()}`;
  inserted = await insertMessageWithAttachments(page, subject, {
    [DOCX]: await readFile(`${FIXTURES}/${DOCX}`),
    [XLSX]: await readFile(`${FIXTURES}/${XLSX}`),
    // No in-browser renderer for slides; the bytes only need to be a file.
    [PPTX]: Buffer.from("PK\u0003\u0004slides"),
  });
});

test.afterEach(async ({ page }) => {
  // Other specs in this group share the mailbox.
  if (inserted) await removeMessage(page, inserted.messageId);
  inserted = undefined;
});

test("previews a Word attachment in the browser, sending it nowhere", async ({
  page,
}, testInfo) => {
  await openInsertedThread(page);
  const thirdPartyRequests = watchThirdPartyRequests(page);

  await page.getByRole("button", { name: `Preview ${DOCX}` }).click();
  const dialog = page.getByRole("dialog", { name: DOCX });
  const document = dialog.frameLocator(`iframe[title="${DOCX}"]`);
  await expect(document.getByText("Quarterly planning notes")).toBeVisible({
    timeout: 30_000,
  });
  await expect(document.getByText("Beta invites")).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "office-docx-preview");

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe(DOCX);
  expect(thirdPartyRequests()).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("previews an Excel attachment sheet by sheet", async ({
  page,
}, testInfo) => {
  await openInsertedThread(page);
  const thirdPartyRequests = watchThirdPartyRequests(page);

  await page.getByRole("button", { name: `Preview ${XLSX}` }).click();
  const dialog = page.getByRole("dialog", { name: XLSX });
  await expect(dialog.getByRole("cell", { name: "Design review" })).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(dialog.getByRole("cell", { name: "1200" })).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "office-xlsx-preview");

  await dialog.getByRole("button", { name: "Notes" }).click();
  await expect(
    dialog.getByRole("cell", { name: "Approved by finance" }),
  ).toBeVisible();
  expect(thirdPartyRequests()).toEqual([]);
});

test("keeps PowerPoint attachments download-only", async ({ page }) => {
  await openInsertedThread(page);

  await expect(page.getByText(PPTX, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Preview ${PPTX}` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Download ${PPTX}` }),
  ).toBeVisible();
});

async function openInsertedThread(page: Page) {
  if (!inserted) throw new Error("No message was inserted");
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/mail?thread-id=${inserted.threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(DOCX, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Requests that leave the app and the emulators, as an online viewer's frame
 * or an upload would. Avatars and fonts load on their own and aren't mail.
 */
function watchThirdPartyRequests(page: Page) {
  const allowed = new Set(
    [
      page.url(),
      process.env.GOOGLE_BASE_URL,
      process.env.MICROSOFT_BASE_URL,
      process.env.NEXT_PUBLIC_BASE_URL,
    ]
      .filter((url): url is string => !!url)
      .map((url) => new URL(url).origin),
  );
  const offending: string[] = [];
  page.on("request", (request) => {
    if (["image", "font"].includes(request.resourceType())) return;
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (!allowed.has(url.origin)) offending.push(url.origin);
  });
  return () => offending;
}

async function insertMessageWithAttachments(
  page: Page,
  subject: string,
  files: Record<string, Buffer>,
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  return isMicrosoftPlaywright()
    ? insertOutlookMessage(page, { email, subject, files })
    : insertGmailMessage(page, { email, subject, files });
}

async function insertGmailMessage(
  page: Page,
  {
    email,
    subject,
    files,
  }: { email: string; subject: string; files: Record<string, Buffer> },
) {
  const boundary = "playwright-office-boundary";
  const mime = [
    "From: Morgan Example <morgan@example.com>",
    `To: ${email}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "The planning files are attached.",
    ...Object.entries(files).flatMap(([name, bytes]) => [
      `--${boundary}`,
      `Content-Type: ${TYPES[name]}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      bytes.toString("base64"),
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await page.request.post(
    `${gmailBaseUrl()}/gmail/v1/users/me/messages`,
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
    files,
  }: { email: string; subject: string; files: Record<string, Buffer> },
) {
  const created = await page.request.post(
    `${outlookBaseUrl()}/v1.0/me/messages`,
    {
      headers: OUTLOOK_HEADERS,
      data: {
        subject,
        body: {
          contentType: "text",
          content: "The planning files are attached.",
        },
        toRecipients: [{ emailAddress: { address: email } }],
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  for (const [name, bytes] of Object.entries(files)) {
    const attached = await page.request.post(
      `${outlookBaseUrl()}/v1.0/me/messages/${id}/attachments`,
      {
        headers: OUTLOOK_HEADERS,
        data: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name,
          contentType: TYPES[name],
          contentBytes: bytes.toString("base64"),
        },
      },
    );
    expect(attached.ok(), await attached.text()).toBe(true);
  }
  // Created messages start as drafts; moving one to the inbox delivers it.
  const moved = await page.request.post(
    `${outlookBaseUrl()}/v1.0/me/messages/${id}/move`,
    { headers: OUTLOOK_HEADERS, data: { destinationId: "inbox" } },
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
      `${outlookBaseUrl()}/v1.0/me/messages/${messageId}`,
      {
        headers: OUTLOOK_HEADERS,
      },
    );
    return;
  }
  await page.request.post(
    `${gmailBaseUrl()}/gmail/v1/users/me/messages/${messageId}/trash`,
    {
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
      },
    },
  );
}

const OUTLOOK_HEADERS = {
  Authorization: "Bearer playwright_microsoft_fixture_token",
  "content-type": "application/json",
};

function gmailBaseUrl() {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  return baseUrl;
}

function outlookBaseUrl() {
  const baseUrl = process.env.MICROSOFT_BASE_URL;
  if (!baseUrl) throw new Error("MICROSOFT_BASE_URL is missing");
  return baseUrl;
}
