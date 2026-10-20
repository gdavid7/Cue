/**
 * E2E Flow Test: Reply suggestion lifecycle (formerly draft cleanup)
 *
 * A rule's reply is a suggestion kept in Cue: the mailbox never holds a draft
 * for it until the user edits it in Cue. These flows check how it settles:
 * - The user sends their own reply: written without the suggestion
 * - The user sends the suggestion as it is: used, and logged
 * - A newer message in the thread: the earlier suggestion is set aside
 * - Drafts the user makes themselves are never touched
 *
 * Usage:
 * RUN_E2E_FLOW_TESTS=true pnpm test-e2e draft-cleanup
 */

import { describe, test, expect, beforeAll, afterEach } from "vitest";
import { DraftEmailStatus } from "@/generated/prisma/enums";
import { shouldRunFlowTests, TIMEOUTS } from "./config";
import { initializeFlowTests, setupFlowTest } from "./setup";
import { generateTestSummary } from "./teardown";
import {
  assertNoThreadDrafts,
  sendTestEmail,
  sendTestReply,
  TEST_EMAIL_SCENARIOS,
} from "./helpers/email";
import {
  waitForExecutedRule,
  waitForMessageInInbox,
  waitForDraftSendLog,
  waitForReplySuggestion,
  waitForSuggestionStatus,
} from "./helpers/polling";
import { logStep, clearLogs } from "./helpers/logging";
import type { TestAccount } from "./helpers/accounts";

describe.skipIf(!shouldRunFlowTests())("Reply suggestion lifecycle", () => {
  let gmail: TestAccount;
  let outlook: TestAccount;
  let testStartTime: number;

  beforeAll(async () => {
    await initializeFlowTests();
    const accounts = await setupFlowTest();
    gmail = accounts.gmail;
    outlook = accounts.outlook;
  }, TIMEOUTS.TEST_DEFAULT);

  afterEach(async () => {
    generateTestSummary("Reply suggestion lifecycle", testStartTime);
    clearLogs();
  });

  /** Mail that needs a reply arrives; the rule keeps a suggestion in Cue. */
  async function receiveWithSuggestion({
    from,
    to,
    subject,
    body,
  }: {
    from: TestAccount;
    to: TestAccount;
    subject: string;
    body: string;
  }) {
    const sentEmail = await sendTestEmail({ from, to, subject, body });
    const received = await waitForMessageInInbox({
      provider: to.emailProvider,
      subjectContains: sentEmail.fullSubject,
      timeout: TIMEOUTS.EMAIL_DELIVERY,
    });
    await waitForExecutedRule({
      threadId: received.threadId,
      emailAccountId: to.id,
      timeout: TIMEOUTS.WEBHOOK_PROCESSING,
    });
    const suggestion = await waitForReplySuggestion({
      threadId: received.threadId,
      emailAccountId: to.id,
    });
    await assertNoThreadDrafts({
      provider: to.emailProvider,
      threadId: received.threadId,
    });
    logStep("Reply suggestion kept in Cue", {
      executedActionId: suggestion.executedActionId,
    });
    return { sentEmail, received, suggestion };
  }

  test.each([
    ["Outlook receiver", () => ({ sender: gmail, receiver: outlook })],
    ["Gmail receiver", () => ({ sender: outlook, receiver: gmail })],
  ])(
    "settles the suggestion as unused when the user writes their own reply (%s)",
    async (_, accounts) => {
      testStartTime = Date.now();
      const { sender, receiver } = accounts();
      const scenario = TEST_EMAIL_SCENARIOS.NEEDS_REPLY;
      const { received, suggestion } = await receiveWithSuggestion({
        from: sender,
        to: receiver,
        subject: scenario.subject,
        body: scenario.body,
      });

      logStep("User sends their own reply");
      await sendTestReply({
        from: receiver,
        to: sender,
        threadId: received.threadId,
        originalMessageId: received.messageId,
        body: "This is my own manually written response, not Cue's suggestion.",
      });

      const draftSendLog = await waitForDraftSendLog({
        threadId: received.threadId,
        emailAccountId: receiver.id,
        timeout: TIMEOUTS.WEBHOOK_PROCESSING,
      });
      expect(draftSendLog.similarityScore).toBeLessThan(0.9);
      expect(draftSendLog.draftId).toBeNull();
      await waitForSuggestionStatus({
        executedActionId: suggestion.executedActionId,
        statuses: [DraftEmailStatus.REPLIED_WITHOUT_DRAFT],
      });
      await assertNoThreadDrafts({
        provider: receiver.emailProvider,
        threadId: received.threadId,
      });
    },
    TIMEOUTS.FULL_CYCLE,
  );

  test.each([
    ["Outlook receiver", () => ({ sender: gmail, receiver: outlook })],
    ["Gmail receiver", () => ({ sender: outlook, receiver: gmail })],
  ])(
    "counts the suggestion as used when it is sent as it is (%s)",
    async (_, accounts) => {
      testStartTime = Date.now();
      const { sender, receiver } = accounts();
      const scenario = TEST_EMAIL_SCENARIOS.QUESTION;
      const { received, suggestion } = await receiveWithSuggestion({
        from: sender,
        to: receiver,
        subject: scenario.subject,
        body: scenario.body,
      });

      logStep("User sends Cue's suggestion as it is");
      await sendTestReply({
        from: receiver,
        to: sender,
        threadId: received.threadId,
        originalMessageId: received.messageId,
        body: suggestion.content,
      });

      const draftSendLog = await waitForDraftSendLog({
        threadId: received.threadId,
        emailAccountId: receiver.id,
        timeout: TIMEOUTS.WEBHOOK_PROCESSING,
      });
      expect(draftSendLog.similarityScore).toBeGreaterThanOrEqual(0.9);
      expect(draftSendLog.wasSentFromDraft).toBe(true);
      await waitForSuggestionStatus({
        executedActionId: suggestion.executedActionId,
        statuses: [DraftEmailStatus.LIKELY_SENT],
      });
    },
    TIMEOUTS.FULL_CYCLE,
  );

  test(
    "sets an earlier suggestion aside when a newer message arrives",
    async () => {
      testStartTime = Date.now();
      const { sentEmail, received, suggestion } = await receiveWithSuggestion({
        from: gmail,
        to: outlook,
        subject: "Multi-message suggestion test",
        body: "First question: What is the project timeline?",
      });

      logStep("Sender follows up in the same thread");
      await sendTestReply({
        from: gmail,
        to: outlook,
        threadId: sentEmail.threadId,
        originalMessageId: sentEmail.messageId,
        body: "Second question: who owns the launch checklist?",
      });

      await waitForSuggestionStatus({
        executedActionId: suggestion.executedActionId,
        statuses: [DraftEmailStatus.CLEANED_UP_UNUSED],
      });
      await assertNoThreadDrafts({
        provider: outlook.emailProvider,
        threadId: received.threadId,
      });
    },
    TIMEOUTS.FULL_CYCLE,
  );

  test(
    "never touches a draft the user made themselves",
    async () => {
      testStartTime = Date.now();
      const scenario = TEST_EMAIL_SCENARIOS.QUESTION;
      const { sentEmail, received, suggestion } = await receiveWithSuggestion({
        from: gmail,
        to: outlook,
        subject: scenario.subject,
        body: scenario.body,
      });

      logStep("User writes their own draft in the mailbox");
      const userDraft = await outlook.emailProvider.createDraft({
        to: gmail.email,
        subject: `Re: ${sentEmail.fullSubject}`,
        messageHtml: "<p>This is my manual draft that I created myself</p>",
        replyToMessageId: received.messageId,
      });

      logStep("User sends a different reply");
      await sendTestReply({
        from: outlook,
        to: gmail,
        threadId: received.threadId,
        originalMessageId: received.messageId,
        body: "Here is my actual reply, not from any draft.",
      });
      await waitForSuggestionStatus({
        executedActionId: suggestion.executedActionId,
        statuses: [
          DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
          DraftEmailStatus.LIKELY_SENT,
        ],
      });

      const userDraftAfter = await outlook.emailProvider.getDraft(userDraft.id);
      expect(userDraftAfter).not.toBeNull();

      await outlook.emailProvider.deleteDraft(userDraft.id);
    },
    TIMEOUTS.FULL_CYCLE,
  );
});
