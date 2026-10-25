import { expect, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { readProviderAccessToken } from "./mail-test-helpers";

export const SENDER = { name: "Morgan Example", address: "morgan@example.com" };

/**
 * Delivers a message with the given files to the inbox, the primary's unless
 * `mailbox` names another; tests remove it afterwards.
 */
export async function insertMessageWithAttachments(
  page: Page,
  input: {
    subject: string;
    attachments: Attachment[];
    html?: string;
    mailbox?: Mailbox;
  },
) {
  const email = input.mailbox?.email ?? process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const html = input.html ?? "<p>The files are attached.</p>";
  const token = await mailboxToken(input.mailbox);
  return isMicrosoftPlaywright()
    ? insertOutlookMessage(page, { ...input, email, html, token })
    : insertGmailMessage(page, { ...input, email, html, token });
}

/** Another seeded mailbox, as createSecondEmailAccount returns it. */
type Mailbox = { email: string; token: string };

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
    html,
    token,
  }: {
    email: string;
    subject: string;
    attachments: Attachment[];
    html: string;
    token: string;
  },
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
    html,
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
        Authorization: `Bearer ${token}`,
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
    html,
    token,
  }: {
    email: string;
    subject: string;
    attachments: Attachment[];
    html: string;
    token: string;
  },
) {
  const outlook = baseUrl("MICROSOFT_BASE_URL");
  const headers = outlookHeaders(token);
  const created = await page.request.post(`${outlook}/v1.0/me/messages`, {
    headers,
    data: {
      subject,
      from: { emailAddress: SENDER },
      body: {
        contentType: "html",
        content: html,
      },
      toRecipients: [{ emailAddress: { address: email } }],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  try {
    for (const { name, type, bytes, inline } of attachments) {
      const attached = await page.request.post(
        `${outlook}/v1.0/me/messages/${id}/attachments`,
        {
          headers,
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
  } catch (error) {
    // A half-built draft would linger in Drafts for other specs.
    await page.request.delete(`${outlook}/v1.0/me/messages/${id}`, {
      headers,
    });
    throw error;
  }
  // Created messages start as drafts; moving one to the inbox delivers it.
  const moved = await page.request.post(
    `${outlook}/v1.0/me/messages/${id}/move`,
    {
      headers,
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

export async function removeMessage(
  page: Page,
  messageId: string,
  mailbox?: Mailbox,
) {
  const token = await mailboxToken(mailbox);
  if (isMicrosoftPlaywright()) {
    await page.request.delete(
      `${baseUrl("MICROSOFT_BASE_URL")}/v1.0/me/messages/${messageId}`,
      { headers: outlookHeaders(token) },
    );
    return;
  }
  await page.request.post(
    `${baseUrl("GOOGLE_BASE_URL")}/gmail/v1/users/me/messages/${messageId}/trash`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

async function mailboxToken(mailbox: Mailbox | undefined) {
  if (mailbox) return mailbox.token;
  return isMicrosoftPlaywright()
    ? "playwright_microsoft_fixture_token"
    : readProviderAccessToken();
}

function outlookHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function baseUrl(name: "GOOGLE_BASE_URL" | "MICROSOFT_BASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}
