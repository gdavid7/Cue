import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  insertInboxMailInConversation,
  openMail,
  openMailboxFromSidebar,
  readLatestMailMutation,
  readProviderAccessToken,
  requestMailSync,
  waitForMetadataCoverage,
} from "./mail-test-helpers";

const THREAD_ID = "thr_playwright_archive";
const SUBJECT = "Archive Action Message";

test("keeps an archived conversation hidden through engine reconciliation", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const conversation = conversationWithSubject(page, conversations, SUBJECT);
  await expect(conversation).toHaveCount(1);

  const cleanupErrors: unknown[] = [];
  try {
    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect
      .poll(() =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "archive",
          threadId: THREAD_ID,
        }),
      )
      .toMatchObject({
        status: expect.stringMatching(/^(reconciling|succeeded)$/),
      });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "archive-awaiting-final-page",
    );

    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "archive",
            threadId: THREAD_ID,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });
    await expect(conversation).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "archive-reconciled");
  } finally {
    await page.request
      .post(`/api/threads/${THREAD_ID}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

test("keeps a queued archive hidden after an OPFS reload", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const conversation = conversationWithSubject(page, conversations, SUBJECT);
  await expect(conversation).toHaveCount(1);

  let archiveQueued = false;
  let releaseExecute = () => {};
  const held = new Promise<void>((resolve) => {
    releaseExecute = resolve;
  });
  await page.route(
    "**/api/mail/v1/accounts/**/operations/**",
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await held;
      await route.continue();
    },
  );

  const cleanupErrors: unknown[] = [];
  try {
    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect
      .poll(() =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "archive",
          threadId: THREAD_ID,
        }),
      )
      .toMatchObject({
        status: "reconciling",
      });
    archiveQueued = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloaded = page.getByRole("listbox", { name: "Conversations" });
    await expect(reloaded.getByRole("option").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(conversationWithSubject(page, reloaded, SUBJECT)).toHaveCount(
      0,
    );
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "archive-queued-after-opfs-reload",
    );
  } finally {
    releaseExecute();
    if (archiveQueued) {
      await expect
        .poll(
          () =>
            readLatestMailMutation(page, {
              emailAccountId,
              kind: "archive",
              threadId: THREAD_ID,
            }),
          { timeout: 60_000 },
        )
        .toMatchObject({ status: "succeeded" });
    }
    await page.request
      .post(`/api/threads/${THREAD_ID}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

test("drops Inbox and Unread counts when an unread conversation is archived", async ({
  page,
}, testInfo) => {
  const threadId = "thr_playwright_3";
  const subject = "Second Unread Command Message";
  const { conversations, emailAccountId } = await openMail(page);
  const conversation = conversationWithSubject(page, conversations, subject);
  await expect(conversation).toBeVisible();
  // The counts are compared against this baseline, so the first sync must
  // have finished filling the inbox before it is read.
  await waitForMetadataCoverage(page);
  await expect.poll(() => inboxUnreadBadge(page)).toBeGreaterThan(0);
  const before = await inboxUnreadBadge(page);

  const cleanupErrors: unknown[] = [];
  try {
    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect.poll(() => inboxUnreadBadge(page)).toBe(before - 1);
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "unread-list-after-archive-count",
    );

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "archive",
            threadId,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });
    const unarchive = await page.request.post(
      `/api/threads/${threadId}/unarchive`,
      { headers: { "X-Email-Account-ID": emailAccountId } },
    );
    expect(unarchive.ok()).toBe(true);
    await requestMailSync(page);
    await expect(conversation).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => inboxUnreadBadge(page)).toBe(before);
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(conversation).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "unread-list-after-provider-unarchive",
    );
  } finally {
    await page.request
      .post(`/api/threads/${threadId}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

test("returns an archived conversation when new mail arrives in it", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const conversation = conversationWithSubject(page, conversations, SUBJECT);
  await expect(conversation).toHaveCount(1);

  const cleanupErrors: unknown[] = [];
  try {
    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "archive",
            threadId: THREAD_ID,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });
    await expect(conversation).toHaveCount(0);
    await insertInboxMailInConversation(page, {
      threadId: THREAD_ID,
      messageId: "msg_playwright_archive",
      subject: SUBJECT,
      from: "Erin Example <erin@example.com>",
    });
    await requestMailSync(page);
    await expect(conversation).toBeVisible({ timeout: 60_000 });
    await capturePlaywrightCheckpoint(page, testInfo, "archive-then-new-mail");
  } finally {
    await page.request
      .post(`/api/threads/${THREAD_ID}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

test("keeps the user's own reply in Sent when archiving a conversation they replied to", async ({
  page,
}, testInfo) => {
  const threadId = "thr_playwright_reply";
  const subject = "Reply Workflow Message";
  const { conversations, emailAccountId } = await openMail(page);
  // The reply's own subject ("Re: ...") can head the row once it lands.
  const conversation = conversations
    .getByRole("option")
    .filter({ hasText: subject });
  await expect(conversation).toBeVisible();
  const token = await readProviderAccessToken();
  const replyId = await replyFromProvider(page.request, token, {
    threadId,
    messageId: "msg_playwright_reply",
    subject,
  });
  await requestMailSync(page);
  await openMailboxFromSidebar(page, "Sent");
  await expect(conversation).toBeVisible({ timeout: 60_000 });
  await openMailboxFromSidebar(page, "Inbox");
  await expect(conversation).toBeVisible();

  const cleanupErrors: unknown[] = [];
  try {
    await conversation.getByRole("checkbox", { includeHidden: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(conversation).toHaveCount(0);
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "archive",
            threadId,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });

    expect(await isInProviderSent(page.request, token, replyId)).toBe(true);
    await openMailboxFromSidebar(page, "Sent");
    await expect(conversation).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "archived-reply-in-sent");
  } finally {
    await page.request
      .post(`/api/threads/${threadId}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});

function inboxLink(page: Page) {
  return page.getByRole("link", { name: /^Inbox(?:\s+\d+)?$/ });
}

async function inboxUnreadBadge(page: Page) {
  const name = (await inboxLink(page).innerText()).replace(/\s+/g, " ").trim();
  const match = name.match(/^Inbox(?: (\d+))?$/);
  return match?.[1] ? Number(match[1]) : 0;
}

// Replies as the provider's own client would, and returns the reply's id.
async function replyFromProvider(
  request: APIRequestContext,
  token: string,
  input: { threadId: string; messageId: string; subject: string },
) {
  const headers = { Authorization: `Bearer ${token}` };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const comment = "Replying before archiving this conversation.";
    const reply = await request.post(
      `${base}/messages/${input.messageId}/reply`,
      { headers, data: { comment } },
    );
    expect(reply.ok(), await reply.text()).toBe(true);
    const sent = await outlookSentItems(request, token);
    const message = sent.find(
      (item) =>
        item.conversationId === input.threadId &&
        item.bodyPreview.includes(comment),
    );
    if (!message) throw new Error("The Outlook reply is not in Sent Items");
    return message.id;
  }
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const inserted = await request.post(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages`,
    {
      headers: { ...headers, "content-type": "application/json" },
      data: {
        threadId: input.threadId,
        from: email,
        to: "leslie@example.com",
        subject: `Re: ${input.subject}`,
        body_text: "Replying before archiving this conversation.",
        labelIds: ["SENT"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  return ((await inserted.json()) as { id: string }).id;
}

async function isInProviderSent(
  request: APIRequestContext,
  token: string,
  messageId: string,
) {
  if (isMicrosoftPlaywright()) {
    const sent = await outlookSentItems(request, token);
    return sent.some((item) => item.id === messageId);
  }
  const message = await request.get(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${messageId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(message.ok(), await message.text()).toBe(true);
  const { labelIds } = (await message.json()) as { labelIds?: string[] };
  return labelIds?.includes("SENT") ?? false;
}

async function outlookSentItems(request: APIRequestContext, token: string) {
  const sent = await request.get(
    `${process.env.MICROSOFT_BASE_URL}/v1.0/me/mailFolders/sentitems/messages?$top=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(sent.ok(), await sent.text()).toBe(true);
  const { value } = (await sent.json()) as {
    value: Array<{ id: string; conversationId: string; bodyPreview: string }>;
  };
  return value;
}
