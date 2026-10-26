import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { isMicrosoftPlaywright } from "../mail-provider";
import {
  activeSnoozeCount,
  conversationWithSubject,
  insertInboxThread,
  openMail,
  openMailboxFromSidebar,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

const SUBSCRIPTION_ID = "playwright-snooze-wake-subscription";
const PREMIUM_ID = "playwright-snooze-wake-premium";
const SENDER = { name: "Wren Example", address: "wren@example.com" };

// Changes the shared emulator account (premium, filing, watch ids) and puts it
// back; the emulated suite runs one spec at a time on one worker.
test("a reply from someone else brings a snoozed conversation back early", async ({
  page,
}, testInfo) => {
  const subject = `Snooze wake ${Date.now()}`;
  const { emailAccountId } = await openMail(page);
  const token = await readProviderAccessToken();
  const account = await readAccountState(emailAccountId);
  const inserted: string[] = [];
  const cleanupErrors: unknown[] = [];
  let threadId: string | undefined;

  try {
    // Webhook processing runs for premium accounts with rules or filing;
    // filing with nothing to file keeps the model out of it.
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO "Premium"
          (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
          VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[],
            'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')
          ON CONFLICT (id) DO NOTHING`,
        [PREMIUM_ID],
      );
      await client.query(
        `UPDATE "User" SET "premiumId" = $2
          WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
        [emailAccountId, PREMIUM_ID],
      );
      await client.query(
        `UPDATE "EmailAccount" SET "filingEnabled" = true,
          "filingPrompt" = 'Nothing to file', "watchEmailsSubscriptionId" = $2
          WHERE id = $1`,
        [emailAccountId, SUBSCRIPTION_ID],
      );
    });

    const original = await insertInboxThread(page, {
      subject,
      body: "Can you look at the plan?",
      from: SENDER,
    });
    threadId = original.threadId;
    inserted.push(original.messageId);

    const snoozed = await page.request.post("/api/user/snoozed-threads", {
      headers: { "X-Email-Account-ID": emailAccountId },
      data: {
        threadIds: [threadId],
        snoozedUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
    });
    expect(snoozed.ok(), await snoozed.text()).toBe(true);
    expect(await activeSnoozeCount(emailAccountId, threadId)).toBe(1);
    await expect
      .poll(() => messageInInbox(page, token, original.messageId), {
        timeout: 30_000,
      })
      .toBe(false);

    // A reply has to arrive after the snooze to count as an answer.
    const snoozedAt = await readSnoozedAt(emailAccountId, threadId);
    await expect.poll(() => Date.now() > snoozedAt).toBe(true);
    const historyId = await readGmailHistoryId(page, token);
    if (historyId) {
      await withClient((client) =>
        client.query(
          `UPDATE "EmailAccount" SET "lastSyncedHistoryId" = $2 WHERE id = $1`,
          [emailAccountId, historyId],
        ),
      );
    }
    const replyId = await insertReply(page, token, {
      threadId,
      messageId: original.messageId,
      subject: `Re: ${subject}`,
    });
    inserted.push(replyId);
    await deliverWebhook(page, token, replyId);

    await expect
      .poll(() => activeSnoozeCount(emailAccountId, threadId as string), {
        timeout: 60_000,
      })
      .toBe(0);
    // The whole conversation is back, not only the reply.
    await expect
      .poll(() => messageInInbox(page, token, original.messageId), {
        timeout: 60_000,
      })
      .toBe(true);

    const reopened = await openMail(page);
    await expect(
      conversationWithSubject(page, reopened.conversations, subject).or(
        conversationWithSubject(page, reopened.conversations, `Re: ${subject}`),
      ),
    ).not.toHaveCount(0, { timeout: 60_000 });
    await capturePlaywrightCheckpoint(page, testInfo, "snooze-wake-inbox");

    await openMailboxFromSidebar(page, "Snoozed");
    await expect(
      page
        .getByRole("list", { name: "Snoozed conversations" })
        .or(page.getByText(/^Nothing snoozed\./)),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(subject, { exact: true })).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "snooze-wake-snoozed");
  } finally {
    if (threadId) {
      await withClient((client) =>
        client.query(
          `UPDATE "SnoozedThread" SET status = 'CANCELLED'
            WHERE "emailAccountId" = $1 AND "threadId" = $2
              AND status IN ('PREPARING', 'PENDING', 'EXECUTING')`,
          [emailAccountId, threadId],
        ),
      ).catch((error) => cleanupErrors.push(error));
    }
    for (const messageId of inserted) {
      await deleteProviderMessage(page, token, messageId).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    await withClient(async (client) => {
      await client.query(
        `UPDATE "EmailAccount" SET "filingEnabled" = $2, "filingPrompt" = $3,
          "watchEmailsSubscriptionId" = $4, "lastSyncedHistoryId" = $5
          WHERE id = $1`,
        [
          emailAccountId,
          account.filingEnabled,
          account.filingPrompt,
          account.watchEmailsSubscriptionId,
          account.lastSyncedHistoryId,
        ],
      );
      await client.query(
        `UPDATE "User" SET "premiumId" = $2
          WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
        [emailAccountId, account.premiumId],
      );
      await client.query(`DELETE FROM "Premium" WHERE id = $1`, [PREMIUM_ID]);
    }).catch((error) => cleanupErrors.push(error));
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

async function readSnoozedAt(emailAccountId: string, threadId: string) {
  return withClient(async (client) => {
    // Prisma stores UTC without a zone; the epoch reads it as such.
    const result = await client.query<{ ms: string }>(
      `SELECT EXTRACT(EPOCH FROM "updatedAt") * 1000 AS ms FROM "SnoozedThread"
        WHERE "emailAccountId" = $1 AND "threadId" = $2 AND status = 'PENDING'`,
      [emailAccountId, threadId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("The snooze isn't pending");
    return Number(row.ms);
  });
}

async function readAccountState(emailAccountId: string) {
  return withClient(async (client) => {
    const result = await client.query<{
      filingEnabled: boolean;
      filingPrompt: string | null;
      watchEmailsSubscriptionId: string | null;
      lastSyncedHistoryId: string | null;
      premiumId: string | null;
    }>(
      `SELECT email."filingEnabled", email."filingPrompt",
          email."watchEmailsSubscriptionId", email."lastSyncedHistoryId",
          app_user."premiumId"
        FROM "EmailAccount" email
        JOIN "User" app_user ON app_user.id = email."userId"
        WHERE email.id = $1`,
      [emailAccountId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Missing emulator account");
    return row;
  });
}

/** A reply from someone other than the user, in the snoozed conversation. */
async function insertReply(
  page: Page,
  token: string,
  input: { threadId: string; messageId: string; subject: string },
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const baseUrl = process.env.MICROSOFT_BASE_URL;
    const draft = await page.request.post(
      `${baseUrl}/v1.0/me/messages/${input.messageId}/createReply`,
      { headers },
    );
    expect(draft.ok(), await draft.text()).toBe(true);
    const { id } = (await draft.json()) as { id: string };
    const patched = await page.request.patch(
      `${baseUrl}/v1.0/me/messages/${id}`,
      {
        headers,
        data: {
          subject: input.subject,
          from: { emailAddress: SENDER },
          body: { contentType: "text", content: "Here is my answer." },
          isRead: false,
        },
      },
    );
    expect(patched.ok(), await patched.text()).toBe(true);
    const moved = await page.request.post(
      `${baseUrl}/v1.0/me/messages/${id}/move`,
      { headers, data: { destinationId: "inbox" } },
    );
    expect(moved.ok(), await moved.text()).toBe(true);
    return ((await moved.json()) as { id: string }).id;
  }
  const created = await page.request.post(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages`,
    {
      headers,
      data: {
        threadId: input.threadId,
        from: `${SENDER.name} <${SENDER.address}>`,
        to: email,
        subject: input.subject,
        body_text: "Here is my answer.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function readGmailHistoryId(page: Page, token: string) {
  if (isMicrosoftPlaywright()) return null;
  const response = await page.request.get(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/profile`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.ok()).toBe(true);
  return String((await response.json()).historyId);
}

async function deliverWebhook(page: Page, token: string, messageId: string) {
  const microsoft = isMicrosoftPlaywright();
  const endpoint = microsoft
    ? "/api/outlook/webhook"
    : `/api/google/webhook?token=${encodeURIComponent(process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN ?? "playwright-token")}`;
  const data = microsoft
    ? {
        value: [
          {
            subscriptionId: SUBSCRIPTION_ID,
            clientState:
              process.env.MICROSOFT_WEBHOOK_CLIENT_STATE ??
              "playwright-microsoft-webhook",
            changeType: "created",
            resourceData: { id: messageId },
          },
        ],
      }
    : {
        message: {
          data: Buffer.from(
            JSON.stringify({
              emailAddress: process.env.PLAYWRIGHT_TEST_EMAIL,
              historyId: await readGmailHistoryId(page, token),
            }),
          ).toString("base64"),
        },
      };
  const response = await page.request.post(endpoint, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

async function messageInInbox(page: Page, token: string, messageId: string) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!isMicrosoftPlaywright()) {
    const response = await page.request.get(
      `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${messageId}`,
      { headers },
    );
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()).labelIds ?? []).includes("INBOX");
  }
  const base = process.env.MICROSOFT_BASE_URL;
  const message = await page.request.get(
    `${base}/v1.0/me/messages/${messageId}`,
    {
      headers,
    },
  );
  expect(message.ok(), await message.text()).toBe(true);
  const inbox = await page.request.get(`${base}/v1.0/me/mailFolders/inbox`, {
    headers,
  });
  expect(inbox.ok()).toBe(true);
  return (await message.json()).parentFolderId === (await inbox.json()).id;
}

async function deleteProviderMessage(
  page: Page,
  token: string,
  messageId: string,
) {
  const url = isMicrosoftPlaywright()
    ? `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${messageId}`
    : `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${messageId}`;
  const response = await page.request.delete(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
}
