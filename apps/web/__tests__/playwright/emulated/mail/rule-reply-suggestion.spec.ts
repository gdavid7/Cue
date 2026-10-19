import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  grantAiAccess,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

// The founder's call: a reply a rule writes is a suggestion that waits in Cue.
// It reaches the mailbox as a draft only once the user edits it.
const SUGGESTION = "Hi Jonas, Thursday at 10 works for me. See you then.";
const RULE_ID = "playwright-rule-suggestion-to-reply";
const DRAFT_ACTION_ID = "playwright-rule-suggestion-draft-action";

test.describe.configure({ mode: "serial" });

let restoreAiAccess: (() => Promise<unknown>) | undefined;
let restoreRule: (() => Promise<unknown>) | undefined;

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
  const editor = page.locator(
    '[data-testid="thread-reader"] [data-email-editor-content]',
  );
  await expect(editor).toContainText(SUGGESTION, { timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "rule-suggestion-shown");

  // Long enough for autosave to have written a draft, had it been going to.
  await page.waitForTimeout(4000);
  expect(await countDrafts(page, threadId)).toBe(0);

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Bring the slides.");

  await expect
    .poll(() => countDrafts(page, threadId), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => rememberedDraft(executedActionId), { timeout: 30_000 })
    .toEqual({ content: SUGGESTION });
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
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}) {
  const executedRuleId = `pw_rule_run_${messageId}`;
  const executedActionId = `pw_suggestion_${messageId}`;
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
        (id, "createdAt", "updatedAt", type, "executedRuleId", content,
         "draftStatus", "executionStatus")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'DRAFT_EMAIL', $2, $3,
               'PENDING', 'SUCCEEDED')
       ON CONFLICT (id) DO NOTHING`,
      [executedActionId, executedRuleId, SUGGESTION],
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
