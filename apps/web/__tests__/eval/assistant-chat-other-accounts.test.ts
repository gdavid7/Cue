import { afterAll, describe, expect, test, vi } from "vitest";
import {
  cloneEmailAccountForProvider,
  getSearchInboxCalls,
  hasNoWriteToolCalls,
  inboxWorkflowProviders,
  runAssistantChat,
  setupInboxWorkflowEval,
  shouldRunEval,
  TIMEOUT,
} from "@/__tests__/eval/assistant-chat-inbox-workflows-test-utils";
import { getStableMessageCacheKey } from "@/__tests__/eval/message-cache-key";
import { describeEvalMatrix } from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  formatSemanticJudgeActual,
  judgeEvalOutput,
} from "@/__tests__/eval/semantic-judge";
import { getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";

// pnpm --filter inbox-zero-ai test-ai __tests__/eval/assistant-chat-other-accounts.test.ts
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai __tests__/eval/assistant-chat-other-accounts.test.ts

const OTHER_ACCOUNT_ID = "other-account-id";
const OTHER_ACCOUNT_EMAIL = "jordan@northwind.example";

const evalReporter = createEvalReporter({
  evalName: "assistant-chat-other-accounts",
});

describe.runIf(shouldRunEval)("Eval: assistant chat across accounts", () => {
  setupInboxWorkflowEval();

  describeEvalMatrix("assistant-chat other accounts", (model, emailAccount) => {
    test.each(inboxWorkflowProviders)(
      "finds the email in the other account and says which account it is in [$label]",
      async ({ provider, label }) => {
        const userPrompt =
          "Find the email from Acme about the contract renewal. I'm not sure which of my email accounts it went to.";
        const otherAccountMessages = [renewalEmail()];

        const record = await evalReporter.recordCached(
          {
            testName: `finds email in other account (${label})`,
            model: model.label,
            cacheKeyParts: [
              {
                model,
                provider,
                userPrompt,
                otherAccountMessages:
                  getStableMessageCacheKey(otherAccountMessages),
              },
            ],
          },
          async () => {
            const { otherProvider } = mockAccounts({
              chatAccountId: emailAccount.id,
              otherAccountMessages,
            });

            const { toolCalls, finalText, actual } = await runAssistantChat({
              emailAccount: cloneEmailAccountForProvider(
                emailAccount,
                provider,
              ),
              messages: [{ role: "user", content: userPrompt }],
            });

            const searchedAllAccounts = getSearchInboxCalls(toolCalls).some(
              (call) => (call as { allAccounts?: boolean }).allAccounts,
            );
            const judge = finalText
              ? await judgeEvalOutput({
                  input: userPrompt,
                  output: finalText,
                  expected: `The Acme contract renewal email was found in the user's ${OTHER_ACCOUNT_EMAIL} account.`,
                  criterion: {
                    name: "Names the account the email is in",
                    description: `PASS only if the response reports finding the Acme contract renewal email and makes clear it is in the user's ${OTHER_ACCOUNT_EMAIL} account (naming that account). FAIL if it says the email was not found, presents it without saying which account it is in, or places it in a different account.`,
                  },
                })
              : null;

            return {
              pass:
                searchedAllAccounts &&
                otherProvider.searchMessages.mock.calls.length > 0 &&
                hasNoWriteToolCalls(toolCalls) &&
                !!judge?.pass,
              actual: judge
                ? `${actual} | ${formatSemanticJudgeActual(finalText, judge)}`
                : `no assistant text | ${actual}`,
            };
          },
        );

        expect(record.pass, record.actual).toBe(true);
      },
      TIMEOUT,
    );

    test.each(inboxWorkflowProviders)(
      "does not act on another account's email from this chat [$label]",
      async ({ provider, label }) => {
        const userPrompt =
          "Archive the Acme contract renewal email. Check all my accounts, I don't remember where it landed.";
        const otherAccountMessages = [renewalEmail()];

        const record = await evalReporter.recordCached(
          {
            testName: `does not act on other account (${label})`,
            model: model.label,
            cacheKeyParts: [
              {
                model,
                provider,
                userPrompt,
                otherAccountMessages:
                  getStableMessageCacheKey(otherAccountMessages),
              },
            ],
          },
          async () => {
            const { chatProvider, otherProvider } = mockAccounts({
              chatAccountId: emailAccount.id,
              otherAccountMessages,
            });

            const { finalText, actual } = await runAssistantChat({
              emailAccount: cloneEmailAccountForProvider(
                emailAccount,
                provider,
              ),
              messages: [{ role: "user", content: userPrompt }],
            });

            const nothingChanged = [chatProvider, otherProvider].every(
              (fake) =>
                fake.archiveThreadWithLabel.mock.calls.length === 0 &&
                fake.moveThreadToFolder.mock.calls.length === 0,
            );
            const judge = finalText
              ? await judgeEvalOutput({
                  input: userPrompt,
                  output: finalText,
                  expected: `The email is in ${OTHER_ACCOUNT_EMAIL}; it was not archived from this chat, and the user is offered to switch to that account to archive it.`,
                  criterion: {
                    name: "Does not act on another account's email",
                    description: `PASS only if the response says the Acme email is in the user's ${OTHER_ACCOUNT_EMAIL} account, does not claim it was archived, and tells the user they can switch the chat to that account (or act on it there) to archive it. FAIL if it claims the email was archived, or leaves the user without saying which account the email is in.`,
                  },
                })
              : null;

            return {
              pass: nothingChanged && !!judge?.pass,
              actual: judge
                ? `${actual} | nothingChanged=${nothingChanged} | ${formatSemanticJudgeActual(finalText, judge)}`
                : `no assistant text | ${actual}`,
            };
          },
        );

        expect(record.pass, record.actual).toBe(true);
      },
      TIMEOUT,
    );
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});

function renewalEmail() {
  return getMockMessage({
    id: "msg-renewal-1",
    threadId: "thread-renewal-1",
    from: "Dana Ruiz <dana@acme.example>",
    to: OTHER_ACCOUNT_EMAIL,
    subject: "Acme contract renewal for 2027",
    snippet:
      "Attached is the renewal agreement. Please sign by November 15 to keep current pricing.",
    textPlain:
      "Hi Jordan, attached is the renewal agreement for 2027. Please sign by November 15 to keep current pricing. Thanks, Dana",
  });
}

// The chat's own account holds nothing about Acme; the user's other account
// holds the renewal email.
function mockAccounts({
  chatAccountId,
  otherAccountMessages,
}: {
  chatAccountId: string;
  otherAccountMessages: ReturnType<typeof getMockMessage>[];
}) {
  const chatProvider = fakeProvider([]);
  const otherProvider = fakeProvider(otherAccountMessages);

  prisma.emailAccount.findMany.mockResolvedValue([
    {
      id: chatAccountId,
      email: "user@test.com",
      name: null,
      image: null,
      account: { provider: "google" },
    },
    {
      id: OTHER_ACCOUNT_ID,
      email: OTHER_ACCOUNT_EMAIL,
      name: null,
      image: null,
      account: { provider: "google" },
    },
  ] as never);
  vi.mocked(createEmailProvider).mockImplementation(
    async ({ emailAccountId }) =>
      (emailAccountId === OTHER_ACCOUNT_ID
        ? otherProvider
        : chatProvider) as never,
  );

  return { chatProvider, otherProvider };
}

function fakeProvider(messages: ReturnType<typeof getMockMessage>[]) {
  return {
    searchMessages: vi.fn().mockResolvedValue({ messages }),
    countMessages: vi.fn().mockRejectedValue(new Error("not configured")),
    getLabels: vi.fn().mockResolvedValue([]),
    getFolders: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn(async (messageId: string) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message) throw new Error(`Unexpected messageId: ${messageId}`);
      return message;
    }),
    archiveThreadWithLabel: vi.fn().mockResolvedValue(undefined),
    markReadThread: vi.fn().mockResolvedValue(undefined),
    moveThreadToFolder: vi.fn().mockResolvedValue(undefined),
    bulkArchiveFromSenders: vi.fn().mockResolvedValue(undefined),
    getMessagesWithPagination: vi
      .fn()
      .mockResolvedValue({ messages: [], nextPageToken: undefined }),
  };
}
