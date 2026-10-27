import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { Client } from "pg";
import type { ThreadResponse } from "@/app/api/threads/[id]/route";
import type { ReadComposeDraftResponse } from "@/app/api/user/drafts/route";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import {
  inspectCommandIsActive,
  inspectCommandMatches,
  inspectCommandToMutation,
  type InspectCommand,
} from "@/utils/playwright/mail-inspect-command";
import { parseMailPath } from "@/utils/mail-url";

// A send goes out once its 30-second undo window closes.
export const UNDO_WINDOW_SEND_TIMEOUT_MS = 60_000;
const DEFAULT_SPLIT_RULE_ID = "playwright-default-split-rule";
const DEFAULT_SPLIT_ACTION_ID = "playwright-default-split-action";
const DEFAULT_SPLIT_LABEL_ID = "Label_project";

export async function openMail(page: Page) {
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/mail`, {
    waitUntil: "domcontentloaded",
  });

  // The inbox the server shows at sign-in is a placeholder, not this list;
  // only the mail engine's list can be selected and triaged.
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-mail-inbox-preview]")).toHaveCount(0);

  return { conversations, emailAccountId };
}

/** The open thread in a `/mail/u/{n}/{view}/{threadId}` address. */
export function openThreadIdFromUrl(url: string) {
  const { pathname, search } = new URL(url);
  return parseMailPath(pathname, search)?.threadId ?? null;
}

// These specs share an emulator account, while each case starts with fresh
// device storage. Mailbox drafts from earlier cases would be independent drafts.
export async function clearWorkflowMailboxDrafts(page: Page) {
  const emailAccountId = await getEmailAccountId(page);
  const headers = { "X-Email-Account-ID": emailAccountId };
  const response = await page.request.get(
    "/api/threads/thr_playwright_reply?includeDrafts=true",
    { headers },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const { thread }: ThreadResponse = await response.json();
  for (const message of thread.messages) {
    if (!message.labelIds?.includes("DRAFT")) continue;
    const reference = await page.request.get(
      `/api/user/drafts?messageId=${encodeURIComponent(message.id)}`,
      { headers },
    );
    expect(reference.ok(), await reference.text()).toBe(true);
    const { draftId }: ReadComposeDraftResponse = await reference.json();
    const discarded = await page.request.delete(
      `/api/user/drafts/${encodeURIComponent(draftId)}`,
      { headers },
    );
    expect(discarded.ok(), await discarded.text()).toBe(true);
  }
}

export async function expectThreadReaderBody(
  page: Page,
  text: string,
  timeout = 60_000,
) {
  await expect
    .poll(() => threadReaderBodyHasText(page, text), { timeout })
    .toBe(true);
}

/** Whether the open thread shows `text`, in the reader or a message frame. */
export async function threadReaderBodyHasText(page: Page, text: string) {
  if ((await page.getByTestId("thread-reader").getByText(text).count()) > 0)
    return true;
  const frames = page.locator('iframe[title="Email content preview"]');
  const n = await frames.count();
  for (let i = 0; i < n; i += 1) {
    if ((await frames.nth(i).contentFrame().getByText(text).count()) > 0)
      return true;
  }
  return false;
}

/**
 * The "Sent with" footer is opt-in. Specs that exercise the signature it rides
 * in turn it on for every account and back off afterwards.
 */
export async function setSentWithFooter(enabled: boolean) {
  await withClient((client) =>
    client.query(`UPDATE "EmailAccount" SET "includeSentWithSignature" = $1`, [
      enabled,
    ]),
  );
}

/**
 * The AI routes need a paid plan. Gives every user an admin-granted Plus plan
 * and returns a function that puts back the plans they had.
 */
export async function grantAiAccess() {
  const premiumId = `playwright_ai_access_${process.env.PLAYWRIGHT_RUN_ID ?? "local"}`;
  const previous = await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Premium"
       (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[],
         'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')
       ON CONFLICT (id) DO UPDATE
       SET "adminGrantExpiresAt" = EXCLUDED."adminGrantExpiresAt",
           "updatedAt" = CURRENT_TIMESTAMP`,
      [premiumId],
    );
    const users = await client.query<{ id: string; premiumId: string | null }>(
      `SELECT id, "premiumId" FROM "User" WHERE "premiumId" IS DISTINCT FROM $1`,
      [premiumId],
    );
    await client.query(`UPDATE "User" SET "premiumId" = $1`, [premiumId]);
    return users.rows;
  });

  return () =>
    withClient(async (client) => {
      for (const user of previous) {
        await client.query(
          `UPDATE "User" SET "premiumId" = $2 WHERE id = $1 AND "premiumId" = $3`,
          [user.id, user.premiumId, premiumId],
        );
      }
      await client.query(`DELETE FROM "Premium" WHERE id = $1`, [premiumId]);
    });
}

/**
 * Inbox, Drafts and Sent sit at the top of the sidebar; the rarer mailboxes
 * sit behind the "More" group, which stays open once a view inside it shows.
 */
export async function openMailboxFromSidebar(page: Page, name: string) {
  const link = page.getByRole("link", { name: new RegExp(`^${name}`) });
  if (!(await link.isVisible())) {
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await link.click();
}

/** Switches between the list and split layouts from the toolbar's View menu. */
export async function toggleMailLayout(page: Page) {
  await page.getByRole("button", { name: "View options" }).click();
  const split = page.getByRole("menuitemradio", { name: /^Split/ });
  const target =
    (await split.getAttribute("aria-checked")) === "true"
      ? page.getByRole("menuitemradio", { name: /^List/ })
      : split;
  await target.click();
}

export function conversationWithSubject(
  page: Page,
  conversations: Locator,
  subject: string,
) {
  return conversations
    .getByRole("option")
    .filter({ has: page.getByText(subject, { exact: true }) });
}

export async function waitForComposeOutboxSend(
  page: Page,
  emailAccountId: string,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId: "compose:new-message",
        }),
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS },
    )
    .toMatchObject({ status: "succeeded" });
}

export async function readLatestMailMutation(
  page: Page,
  expected: {
    emailAccountId: string;
    kind: string;
    sender?: string;
    threadId?: string;
    payload?: Record<string, unknown>;
  },
) {
  try {
    const commands = await page.evaluate(async () => {
      const inspect = window.__inboxZeroMailInspect;
      if (!inspect?.read) return;
      const diagnostics = (await inspect.read()) as {
        commands?: InspectCommand[];
      };
      return diagnostics.commands;
    });
    const command = commands
      ?.filter((item) => inspectCommandMatches(item, expected))
      .filter(inspectCommandIsActive)
      .at(-1);
    if (!command) return;
    return inspectCommandToMutation(command);
  } catch (error) {
    if (String(error).includes("Execution context was destroyed")) return;
    throw error;
  }
}

/**
 * Samples the reader on every animation frame while a reply leaves its
 * composer, so a check can see the frames a screenshot would miss.
 */
export async function watchReplyHandoff(page: Page, replyText: string) {
  const rowsBefore = await page.locator("li[data-thread-message-id]").count();
  await page.evaluate((text) => {
    const frames: ReplyHandoffFrame[] = [];
    const state = window as unknown as ReplyHandoffWindow;
    state.__replyHandoff = { frames, raf: 0 };
    const sample = () => {
      frames.push({
        composer: Array.from(
          document.querySelectorAll('[contenteditable="true"]'),
        ).some((element) => element.textContent?.includes(text)),
        rows: document.querySelectorAll("li[data-thread-message-id]").length,
      });
      state.__replyHandoff.raf = requestAnimationFrame(sample);
    };
    sample();
  }, replyText);
  return {
    rowsBefore,
    stop: () =>
      page.evaluate(() => {
        const state = window as unknown as ReplyHandoffWindow;
        cancelAnimationFrame(state.__replyHandoff.raf);
        return state.__replyHandoff.frames;
      }),
  };
}

/**
 * Every frame shows the reply once, either still in its composer or as a new
 * message, and the composer never comes back once the message has replaced it.
 */
export function expectSeamlessReplyHandoff(
  frames: ReplyHandoffFrame[],
  rowsBefore: number,
) {
  const firstClosed = frames.findIndex((frame) => !frame.composer);
  expect(firstClosed).toBeGreaterThanOrEqual(0);
  expect(
    frames.filter((frame) => !frame.composer && frame.rows <= rowsBefore),
  ).toEqual([]);
  expect(frames.filter((frame) => frame.rows > rowsBefore + 1)).toEqual([]);
  expect(frames.slice(firstClosed).filter((frame) => frame.composer)).toEqual(
    [],
  );
  expect(frames.at(-1)?.rows).toBe(rowsBefore + 1);
}

export async function requestMailSync(page: Page) {
  await page
    .evaluate(async () => {
      await window.__inboxZeroMailInspect?.requestSync?.();
    })
    .catch((error) => {
      if (!String(error).includes("Execution context was destroyed"))
        throw error;
    });
}

/** Waits until the engine has listed every scope of the mailbox. */
export async function waitForMetadataCoverage(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const seam = window.__inboxZeroMailInspect;
          if (!seam) return { present: false, coverageComplete: false };
          const diagnostics = (await seam.read()) as {
            coverage?: Array<{ metadata: string }>;
          };
          return {
            present: true,
            coverageComplete:
              (diagnostics.coverage?.length ?? 0) > 0 &&
              diagnostics.coverage?.every(
                (item) => item.metadata === "complete",
              ),
          };
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ present: true, coverageComplete: true });
}

export async function seedDefaultSplitRule(emailAccountId: string) {
  await withClient(async (client) => {
    await deleteDefaultSplitRule(client, emailAccountId);
    await client.query(
      `INSERT INTO "Rule"
        (id, name, enabled, automate, "runOnThreads", "systemType",
         "emailAccountId", "createdAt", "updatedAt")
       VALUES ($1, 'Calendar', true, true, false, 'CALENDAR', $2,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [DEFAULT_SPLIT_RULE_ID, emailAccountId],
    );
    await client.query(
      `INSERT INTO "Action"
        (id, type, "ruleId", "emailAccountId", label, "labelId",
         "createdAt", "updatedAt")
       VALUES ($1, 'LABEL', $2, $3, 'Project Alpha', $4,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        DEFAULT_SPLIT_ACTION_ID,
        DEFAULT_SPLIT_RULE_ID,
        emailAccountId,
        DEFAULT_SPLIT_LABEL_ID,
      ],
    );
  });
}

export async function cleanupDefaultSplitRule(emailAccountId: string) {
  await withClient((client) => deleteDefaultSplitRule(client, emailAccountId));
}

async function deleteDefaultSplitRule(client: Client, emailAccountId: string) {
  await client.query(
    `DELETE FROM "MailSplit"
     WHERE "emailAccountId" = $1
       AND EXISTS (SELECT 1 FROM "MailSplitFilter" f WHERE f."mailSplitId" = "MailSplit".id AND f.kind = 'LABEL' AND f.value = $2)
       AND name = 'Calendar'`,
    [emailAccountId, DEFAULT_SPLIT_LABEL_ID],
  );
  await client.query(
    `DELETE FROM "Rule" WHERE id = $1 AND "emailAccountId" = $2`,
    [DEFAULT_SPLIT_RULE_ID, emailAccountId],
  );
}

export async function withClient<T>(callback: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export async function insertInboxMailInConversation(
  page: Page,
  input: {
    threadId: string;
    messageId: string;
    subject: string;
    from: string;
  },
) {
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  if (isMicrosoftPlaywright()) {
    return insertOutlookInboxReply(page, token, input);
  }
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const inserted = await page.request.post(
    `${baseUrl}/gmail/v1/users/me/messages`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      data: {
        threadId: input.threadId,
        from: input.from,
        to: email,
        subject: input.subject,
        body_text: "New mail in the archived conversation.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string };
  return message.id;
}

/**
 * Puts a new conversation in the inbox, for a test that writes to its thread
 * and must not share one with other tests or with its own earlier attempts.
 */
export async function insertInboxThread(
  page: Page,
  input: {
    subject: string;
    body: string;
    from: { name: string; address: string };
    replyTo?: string;
    cc?: string;
  },
): Promise<{ threadId: string; messageId: string }> {
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const baseUrl = process.env.MICROSOFT_BASE_URL;
    if (!baseUrl) throw new Error("MICROSOFT_BASE_URL is missing");
    const created = await page.request.post(`${baseUrl}/v1.0/me/messages`, {
      headers,
      data: {
        subject: input.subject,
        body: { contentType: "text", content: input.body },
        toRecipients: [{ emailAddress: { address: email } }],
        ...(input.cc && {
          ccRecipients: [{ emailAddress: { address: input.cc } }],
        }),
        ...(input.replyTo && {
          replyTo: [{ emailAddress: { address: input.replyTo } }],
        }),
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    const patched = await page.request.patch(
      `${baseUrl}/v1.0/me/messages/${id}`,
      {
        headers,
        data: {
          from: { emailAddress: input.from },
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
    const message = (await moved.json()) as {
      id: string;
      conversationId: string;
    };
    return { threadId: message.conversationId, messageId: message.id };
  }
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const inserted = await page.request.post(
    `${baseUrl}/gmail/v1/users/me/messages`,
    {
      headers,
      data: {
        from: `${input.from.name} <${input.from.address}>`,
        to: email,
        cc: input.cc,
        reply_to: input.replyTo,
        subject: input.subject,
        body_text: input.body,
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string; threadId: string };
  return { threadId: message.threadId, messageId: message.id };
}

async function insertOutlookInboxReply(
  page: Page,
  token: string,
  input: { messageId: string; subject: string },
) {
  const baseUrl = process.env.MICROSOFT_BASE_URL;
  if (!baseUrl) throw new Error("MICROSOFT_BASE_URL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const draft = await page.request.post(
    `${baseUrl}/v1.0/me/messages/${input.messageId}/createReply`,
    { headers },
  );
  expect(draft.ok(), await draft.text()).toBe(true);
  const draftId = ((await draft.json()) as { id?: string }).id;
  if (!draftId) throw new Error("Outlook createReply did not return an id");
  const patched = await page.request.patch(
    `${baseUrl}/v1.0/me/messages/${draftId}`,
    {
      headers,
      data: {
        subject: input.subject,
        body: {
          contentType: "text",
          content: "New mail in the archived conversation.",
        },
        isRead: false,
      },
    },
  );
  expect(patched.ok(), await patched.text()).toBe(true);
  const moved = await page.request.post(
    `${baseUrl}/v1.0/me/messages/${draftId}/move`,
    {
      headers,
      data: { destinationId: "inbox" },
    },
  );
  expect(moved.ok(), await moved.text()).toBe(true);
  const message = (await moved.json()) as { id: string };
  return message.id;
}

/** Whether the provider has any of the conversation's messages in the inbox. */
export async function providerConversationInInbox(threadId: string) {
  const headers = {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
  };
  if (isMicrosoftPlaywright()) {
    const response = await fetch(
      `${process.env.MICROSOFT_BASE_URL}/v1.0/me/mailFolders/inbox/messages?$top=100`,
      { headers },
    );
    expect(response.ok, await response.clone().text()).toBe(true);
    const { value } = (await response.json()) as {
      value: Array<{ conversationId: string }>;
    };
    return value.some((message) => message.conversationId === threadId);
  }
  const response = await fetch(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/threads/${threadId}`,
    { headers },
  );
  expect(response.ok, await response.clone().text()).toBe(true);
  const { messages } = (await response.json()) as {
    messages: Array<{ labelIds?: string[] }>;
  };
  return messages.some((message) => message.labelIds?.includes("INBOX"));
}

/** The conversation's snoozes our database still means to act on. */
export async function activeSnoozeCount(
  emailAccountId: string,
  threadId: string,
) {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM "SnoozedThread"
       WHERE "emailAccountId" = $1 AND "threadId" = $2
         AND status IN ('PREPARING', 'PENDING', 'EXECUTING')`,
      [emailAccountId, threadId],
    );
    return result.rowCount ?? 0;
  });
}

export async function readProviderAccessToken() {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const token = await withClient(async (client) => {
    const result = await client.query<{ access_token: string | null }>(
      `SELECT account.access_token
       FROM "EmailAccount" email_account
       JOIN "Account" account ON account.id = email_account."accountId"
       WHERE email_account.email = $1`,
      [email],
    );
    return result.rows[0]?.access_token ?? null;
  });
  if (!token) throw new Error("Could not read the Playwright provider token");
  return token;
}

type ReplyHandoffFrame = { composer: boolean; rows: number };

type ReplyHandoffWindow = {
  __replyHandoff: { frames: ReplyHandoffFrame[]; raf: number };
};

const KAI = { address: "kai@example.com", name: "Kai Example" };

/**
 * A conversation the user started with Kai, who answered an hour later: an
 * inbox reply from someone the user writes to, with nothing sent after it.
 * `reply` sends the answer from someone else, as a mail server's bounce.
 * Returns its thread and what takes it out again.
 */
export async function seedMailFromContact(
  page: Page,
  subject: string,
  reply: { from?: { name: string; address: string }; subject?: string } = {},
) {
  const replyFrom = reply.from ?? KAI;
  const replySubject = reply.subject ?? subject;
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const body = "Are we still on for Thursday?";
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const draft = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "Dinner Thursday?" },
        toRecipients: [
          { emailAddress: { address: KAI.address, name: KAI.name } },
        ],
      },
    });
    expect(draft.ok(), await draft.text()).toBe(true);
    const draftId = ((await draft.json()) as { id: string }).id;
    const sent = await page.request.post(`${base}/messages/${draftId}/move`, {
      headers,
      data: { destinationId: "sentitems" },
    });
    expect(sent.ok(), await sent.text()).toBe(true);
    const sentId = ((await sent.json()) as { id: string }).id;
    const reply = await page.request.post(
      `${base}/messages/${sentId}/createReply`,
      { headers },
    );
    expect(reply.ok(), await reply.text()).toBe(true);
    const replyId = ((await reply.json()) as { id: string }).id;
    const patched = await page.request.patch(`${base}/messages/${replyId}`, {
      headers,
      data: {
        from: { emailAddress: replyFrom },
        ...(reply.subject ? { subject: replySubject } : {}),
        toRecipients: [{ emailAddress: { address: email } }],
        body: { contentType: "text", content: body },
        isRead: false,
      },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const moved = await page.request.post(`${base}/messages/${replyId}/move`, {
      headers,
      data: { destinationId: "inbox" },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const message = (await moved.json()) as {
      id: string;
      conversationId: string;
    };
    return {
      threadId: message.conversationId,
      subject,
      remove: async () => {
        for (const id of [message.id, sentId])
          await page.request.post(`${base}/messages/${id}/permanentDelete`, {
            headers,
          });
      },
    };
  }

  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const sent = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      from: email,
      to: `${KAI.name} <${KAI.address}>`,
      subject,
      body_text: "Dinner Thursday?",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - 2 * 3_600_000),
    },
  });
  expect(sent.ok(), await sent.text()).toBe(true);
  const first = (await sent.json()) as { id: string; threadId: string };
  const inserted = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      threadId: first.threadId,
      from: `${replyFrom.name} <${replyFrom.address}>`,
      to: email,
      subject: replySubject,
      body_text: body,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: String(Date.now() - 3_600_000),
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string };
  return {
    threadId: first.threadId,
    subject,
    remove: async () => {
      for (const id of [message.id, first.id])
        await page.request.delete(`${base}/messages/${id}`, { headers });
    },
  };
}

export async function setPremium(
  emailAccountId: string,
  premiumId: string | null,
) {
  await withClient((client) =>
    client.query(
      `UPDATE "User" SET "premiumId" = $2
        WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId, premiumId],
    ),
  );
}

/** A reply from someone other than the user, in the snoozed conversation. */
export async function insertReply(
  page: Page,
  token: string,
  input: { threadId: string; messageId: string; subject: string },
  sender: { name: string; address: string },
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
          from: { emailAddress: sender },
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
        from: `${sender.name} <${sender.address}>`,
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

export async function messageInInbox(
  page: Page,
  token: string,
  messageId: string,
) {
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

export async function deleteProviderMessage(
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

/**
 * The account a mail request acts as: the account header on API requests, or
 * a server action's first argument (actions bind the email account id there).
 * The page address is not evidence: it can name another account, such as the
 * open chat's.
 */
export async function requestEmailAccountId(request: Request) {
  const header = await request.headerValue("x-email-account-id");
  if (header) return header;
  if (!(await request.headerValue("next-action"))) return request.url();
  try {
    const args: unknown = JSON.parse(request.postData() ?? "");
    return Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
  } catch {
    return null;
  }
}
