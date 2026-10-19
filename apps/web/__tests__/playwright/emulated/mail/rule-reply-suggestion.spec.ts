import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  grantAiAccess,
  readLatestMailMutation,
  readProviderAccessToken,
  UNDO_WINDOW_SEND_TIMEOUT_MS,
  withClient,
} from "./mail-test-helpers";

// The founder's call: a reply a rule writes is a suggestion that waits in Cue.
// It reaches the mailbox as a draft only once the user edits it.
const SUGGESTION = "Hi Jonas, Thursday at 10 works for me. See you then.";
const RULE_ID = "playwright-rule-suggestion-to-reply";
const DRAFT_ACTION_ID = "playwright-rule-suggestion-draft-action";
// Long enough for autosave to have written a draft, had it been going to.
const AUTOSAVE_WINDOW_MS = 4000;

test.describe.configure({ mode: "serial" });

let restoreAiAccess: (() => Promise<unknown>) | undefined;
let restoreRule: (() => Promise<unknown>) | undefined;
const seededRuns: string[] = [];

test.beforeEach(async ({ page }) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The suggestion is provider-neutral; the Gmail emulator makes its mailbox easy to read.",
  );
  const emailAccountId = await getEmailAccountId(page);
  restoreAiAccess = await grantAiAccess();
  restoreRule = await enableDraftReplies(emailAccountId);
});

test.afterEach(async () => {
  const runs = seededRuns.splice(0);
  if (runs.length) {
    await withClient(async (client) => {
      await client.query(
        `DELETE FROM "SuggestedReplyDraft" WHERE "executedActionId" IN
           (SELECT id FROM "ExecutedAction" WHERE "executedRuleId" = ANY($1))`,
        [runs],
      );
      // Its actions go with it.
      await client.query(`DELETE FROM "ExecutedRule" WHERE id = ANY($1)`, [
        runs,
      ]);
    });
  }
  await restoreRule?.();
  await restoreAiAccess?.();
  restoreRule = undefined;
  restoreAiAccess = undefined;
});

test("shows the rule's suggestion at once, and drafts it only once edited", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const subject = `Thursday meeting ${testInfo.retry}-${Date.now()}`;
  const { threadId, messageId } = await insertMessage(page, subject);
  const executedActionId = await seedSuggestion({
    emailAccountId,
    threadId,
    messageId,
  });

  await openThread(page, emailAccountId, threadId, subject);
  const reader = page.getByTestId("thread-reader");
  const editor = reader.locator("[data-email-editor-content]");
  await expect(editor).toContainText(SUGGESTION, { timeout: 60_000 });
  await expect(reader.getByText("Suggested by Cue")).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "rule-suggestion-shown");

  await page.waitForTimeout(AUTOSAVE_WINDOW_MS);
  expect(await countDrafts(page, threadId)).toBe(0);

  // A reload opens the reply from this device's copy, not the suggestion:
  // it still knows the text is Cue's and saves nothing to the mailbox.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(editor).toContainText(SUGGESTION, { timeout: 60_000 });
  await page.waitForTimeout(AUTOSAVE_WINDOW_MS);
  expect(await countDrafts(page, threadId)).toBe(0);

  // Popped out, the composer no longer has the suggestion handed to it.
  await reader.getByRole("button", { name: "Pop out draft" }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(subject) });
  const dialogEditor = dialog.locator("[contenteditable='true']");
  await expect(dialogEditor).toContainText(SUGGESTION);
  await page.waitForTimeout(AUTOSAVE_WINDOW_MS);
  expect(await countDrafts(page, threadId)).toBe(0);

  await dialogEditor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Bring the slides.");

  await expect
    .poll(() => countDrafts(page, threadId), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => rememberedDraft(executedActionId), { timeout: 30_000 })
    .toEqual({ content: SUGGESTION });
});

test("sends the suggestion as it is without a draft", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const subject = `Contract question ${testInfo.retry}-${Date.now()}`;
  const { threadId, messageId } = await insertMessage(page, subject);
  await seedSuggestion({ emailAccountId, threadId, messageId });

  await openThread(page, emailAccountId, threadId, subject);
  const reader = page.getByTestId("thread-reader");
  await expect(reader.locator("[data-email-editor-content]")).toContainText(
    SUGGESTION,
    { timeout: 60_000 },
  );

  await reader.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId,
        }),
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS },
    )
    .toMatchObject({ status: "succeeded" });

  await expect
    .poll(() => sentReplyText(page, threadId), { timeout: 30_000 })
    .toContain("Thursday at 10 works for me");
  expect(await countDrafts(page, threadId)).toBe(0);
  await capturePlaywrightCheckpoint(page, testInfo, "rule-suggestion-sent");
});

// D-084: a rule can write to someone other than the sender. It opens
// addressed to them, and says so, rather than passing as the reply.
test("opens a rule's reply to someone else addressed and labelled as theirs", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const subject = `Invoice forward ${testInfo.retry}-${Date.now()}`;
  const { threadId, messageId } = await insertMessage(page, subject);
  await seedSuggestion({
    emailAccountId,
    threadId,
    messageId,
    to: "finance@partner.example",
  });

  await openThread(page, emailAccountId, threadId, subject);
  const reader = page.getByTestId("thread-reader");
  await expect(reader.locator("[data-email-editor-content]")).toContainText(
    SUGGESTION,
    { timeout: 60_000 },
  );
  await expect(
    reader.getByText("Cue's draft to finance@partner.example"),
  ).toBeVisible();
  await expect(reader.getByText("Suggested by Cue")).toHaveCount(0);
  // Addressed to finance alone: the sender isn't on it.
  const recipients = reader.locator("button[aria-expanded]", {
    hasText: /^(for|to) /,
  });
  await expect(recipients).toContainText("finance");
  await expect(recipients).not.toContainText(/jonas/i);
  await capturePlaywrightCheckpoint(page, testInfo, "rule-suggestion-to-other");
  await page.waitForTimeout(AUTOSAVE_WINDOW_MS);
  expect(await countDrafts(page, threadId)).toBe(0);

  // Sent as it is, it goes to finance only.
  await reader.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId,
        }),
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS },
    )
    .toMatchObject({ status: "succeeded" });
  await expect
    .poll(async () => (await sentReplyRecipients(page, threadId))?.to, {
      timeout: 30_000,
    })
    .toMatch(/^<?finance@partner\.example>?$/);
  expect((await sentReplyRecipients(page, threadId))?.cc).toBe("");
  expect(await countDrafts(page, threadId)).toBe(0);
});

test("dismisses the rule's suggestion when its reply is discarded", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const subject = `Friday lunch ${testInfo.retry}-${Date.now()}`;
  const { threadId, messageId } = await insertMessage(page, subject);
  const executedActionId = await seedSuggestion({
    emailAccountId,
    threadId,
    messageId,
  });

  await openThread(page, emailAccountId, threadId, subject);
  const reader = page.getByTestId("thread-reader");
  const editor = reader.locator("[data-email-editor-content]");
  await expect(editor).toContainText(SUGGESTION, { timeout: 60_000 });

  await reader.getByRole("button", { name: "Discard draft" }).click();

  await expect(editor).toHaveCount(0);
  await expect
    .poll(() => suggestionStatus(executedActionId), { timeout: 30_000 })
    .toBe("DISMISSED");
  expect(await countDrafts(page, threadId)).toBe(0);

  await openThread(page, emailAccountId, threadId, subject);
  await page.waitForTimeout(2000);
  await expect(editor).toHaveCount(0);
});

async function openThread(
  page: Page,
  emailAccountId: string,
  threadId: string,
  subject: string,
) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
}

// The To Reply rule with a draft action is "Auto draft replies" on. The
// database outlives the spec, so whatever was there is put back.
async function enableDraftReplies(emailAccountId: string) {
  return withClient(async (client) => {
    const existing = await client.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'TO_REPLY'`,
      [emailAccountId],
    );
    const rule = existing.rows[0];
    if (rule) {
      await client.query(`UPDATE "Rule" SET enabled = true WHERE id = $1`, [
        rule.id,
      ]);
    } else {
      await client.query(
        `INSERT INTO "Rule"
          (id, name, enabled, automate, "runOnThreads", "systemType",
           "emailAccountId", "createdAt", "updatedAt")
         VALUES ($1, 'Suggestion spec To Reply', true, true, true, 'TO_REPLY',
                 $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        [RULE_ID, emailAccountId],
      );
    }
    const ruleId = rule?.id ?? RULE_ID;
    const drafts = await client.query(
      `SELECT 1 FROM "Action" WHERE "ruleId" = $1 AND type = 'DRAFT_EMAIL'`,
      [ruleId],
    );
    if (!drafts.rowCount) {
      await client.query(
        `INSERT INTO "Action"
          (id, type, "ruleId", "emailAccountId", "createdAt", "updatedAt")
         VALUES ($1, 'DRAFT_EMAIL', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        [DRAFT_ACTION_ID, ruleId, emailAccountId],
      );
    }
    return () =>
      withClient(async (cleanup) => {
        await cleanup.query(`DELETE FROM "Action" WHERE id = $1`, [
          DRAFT_ACTION_ID,
        ]);
        if (rule) {
          await cleanup.query(`UPDATE "Rule" SET enabled = $2 WHERE id = $1`, [
            rule.id,
            rule.enabled,
          ]);
        } else {
          await cleanup.query(`DELETE FROM "Rule" WHERE id = $1`, [RULE_ID]);
        }
      });
  });
}

// What the webhook leaves after the rule drafts: its text on the executed
// action, pending, with no mailbox draft.
async function seedSuggestion({
  emailAccountId,
  threadId,
  messageId,
  to,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
  to?: string;
}) {
  const executedRuleId = `pw_rule_run_${messageId}`;
  const executedActionId = `pw_suggestion_${messageId}`;
  seededRuns.push(executedRuleId);
  await withClient(async (client) => {
    const rule = await client.query<{ id: string }>(
      `SELECT id FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'TO_REPLY'`,
      [emailAccountId],
    );
    await client.query(
      `INSERT INTO "ExecutedRule"
        (id, "createdAt", "updatedAt", "threadId", "messageId", status,
         automated, "ruleId", "emailAccountId")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $2, $3, 'APPLIED',
               true, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [executedRuleId, threadId, messageId, rule.rows[0]?.id, emailAccountId],
    );
    await client.query(
      `INSERT INTO "ExecutedAction"
        (id, "createdAt", "updatedAt", type, "executedRuleId", content, "to",
         "draftStatus", "executionStatus")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'DRAFT_EMAIL', $2, $3,
               $4, 'PENDING', 'SUCCEEDED')
       ON CONFLICT (id) DO NOTHING`,
      [executedActionId, executedRuleId, SUGGESTION, to ?? null],
    );
  });
  return executedActionId;
}

function suggestionStatus(executedActionId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ draftStatus: string | null }>(
      `SELECT "draftStatus" FROM "ExecutedAction" WHERE id = $1`,
      [executedActionId],
    );
    return result.rows[0]?.draftStatus ?? null;
  });
}

function rememberedDraft(executedActionId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ content: string }>(
      `SELECT content FROM "SuggestedReplyDraft" WHERE "executedActionId" = $1`,
      [executedActionId],
    );
    return result.rows[0] ?? null;
  });
}

async function insertMessage(page: Page, subject: string) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const inserted = await page.request.post(
    `${gmailBaseUrl()}/gmail/v1/users/me/messages`,
    {
      headers: await gmailHeaders(),
      data: {
        from: "Jonas Weber <jonas@partner.example>",
        to: email,
        subject,
        body_text: "Does Thursday at 10 work for a quick sync? Jonas",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string; threadId: string };
  return { threadId: message.threadId, messageId: message.id };
}

async function countDrafts(page: Page, threadId: string) {
  const response = await page.request.get(
    `${gmailBaseUrl()}/gmail/v1/users/me/drafts`,
    { headers: await gmailHeaders() },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const { drafts } = (await response.json()) as {
    drafts?: { message?: { threadId?: string } }[];
  };
  return (drafts ?? []).filter((draft) => draft.message?.threadId === threadId)
    .length;
}

/** The text of the thread's sent reply, once the mailbox has it. */
async function sentReplyText(page: Page, threadId: string) {
  const response = await page.request.get(
    `${gmailBaseUrl()}/gmail/v1/users/me/threads/${threadId}`,
    { headers: await gmailHeaders(), params: { format: "full" } },
  );
  if (!response.ok()) return "";
  const { messages } = (await response.json()) as {
    messages?: { labelIds?: string[]; snippet?: string }[];
  };
  return (messages ?? [])
    .filter((message) => message.labelIds?.includes("SENT"))
    .map((message) => message.snippet ?? "")
    .join("\n");
}

/** Who the thread's sent reply went to, once the mailbox has it. */
async function sentReplyRecipients(page: Page, threadId: string) {
  const response = await page.request.get(
    `${gmailBaseUrl()}/gmail/v1/users/me/threads/${threadId}`,
    { headers: await gmailHeaders(), params: { format: "metadata" } },
  );
  if (!response.ok()) return null;
  const { messages } = (await response.json()) as {
    messages?: {
      labelIds?: string[];
      payload?: { headers?: { name: string; value: string }[] };
    }[];
  };
  const sent = messages?.find((message) => message.labelIds?.includes("SENT"));
  if (!sent) return null;
  const header = (name: string) =>
    sent.payload?.headers
      ?.find((item) => item.name.toLowerCase() === name)
      ?.value.trim() ?? "";
  return { to: header("to"), cc: header("cc") };
}

async function gmailHeaders() {
  return {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
    "content-type": "application/json",
  };
}

function gmailBaseUrl() {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  return baseUrl;
}
