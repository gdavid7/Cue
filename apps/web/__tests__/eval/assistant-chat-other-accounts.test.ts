import { afterAll, describe, expect, test, vi } from "vitest";
import {
  cloneEmailAccountForProvider,
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
      "archives another account's email in that account [$label]",
      async ({ provider, label }) => {
        const userPrompt =
          "Archive the Acme contract renewal email. Check all my accounts, I don't remember where it landed.";
        const otherAccountMessages = [renewalEmail()];

        const record = await evalReporter.recordCached(
          {
            testName: `archives in other account (${label})`,
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

            const archivedThere =
              archivedThreadIds(otherProvider).includes("thread-renewal-1");
            const chatAccountUntouched =
              archivedThreadIds(chatProvider).length === 0;
            const judge = finalText
              ? await judgeEvalOutput({
                  input: userPrompt,
                  output: finalText,
                  expected: `The Acme renewal email, found in the user's ${OTHER_ACCOUNT_EMAIL} account, was archived.`,
                  criterion: {
                    name: "Archives the email where it is",
                    description:
                      "PASS only if the response says the Acme contract renewal email was archived, and does not tell the user to switch accounts or chats, or to archive it themselves elsewhere. FAIL if it says the email could not be archived from here, asks the user to switch, or says the email was not found.",
                  },
                })
              : null;

            return {
              pass: archivedThere && chatAccountUntouched && !!judge?.pass,
              actual: judge
                ? `${actual} | archivedThere=${archivedThere} | chatAccountUntouched=${chatAccountUntouched} | ${formatSemanticJudgeActual(finalText, judge)}`
                : `no assistant text | ${actual}`,
            };
          },
        );

        expect(record.pass, record.actual).toBe(true);
      },
      TIMEOUT,
    );

    test.each(inboxWorkflowProviders)(
      "archives search results from two accounts in one call [$label]",
      async ({ provider, label }) => {
        const firstPrompt = "Show me the emails from Acme.";
        const secondPrompt = "Archive these.";
        const chatAccountMessages = [invoiceEmail()];
        const otherAccountMessages = [renewalEmail()];

        const record = await evalReporter.recordCached(
          {
            testName: `archives mixed accounts in one call (${label})`,
            model: model.label,
            cacheKeyParts: [
              {
                model,
                provider,
                firstPrompt,
                secondPrompt,
                chatAccountMessages:
                  getStableMessageCacheKey(chatAccountMessages),
                otherAccountMessages:
                  getStableMessageCacheKey(otherAccountMessages),
              },
            ],
          },
          async () => {
            const { chatProvider, otherProvider } = mockAccounts({
              chatAccountId: emailAccount.id,
              chatAccountMessages,
              otherAccountMessages,
            });
            const chatEmailAccount = cloneEmailAccountForProvider(
              emailAccount,
              provider,
            );

            const first = await runAssistantChat({
              emailAccount: chatEmailAccount,
              messages: [{ role: "user", content: firstPrompt }],
            });
            const firstTurnWrote = !hasNoWriteToolCalls(first.toolCalls);

            const { toolCalls, finalText, actual } = await runAssistantChat({
              emailAccount: chatEmailAccount,
              messages: [
                { role: "user", content: firstPrompt },
                ...first.responseMessages,
                { role: "user", content: secondPrompt },
              ],
            });

            const archiveCalls = toolCalls.filter(
              (call) =>
                call.toolName === "manageInbox" &&
                (call.input as { action?: string })?.action ===
                  "archive_threads",
            );
            const oneCallForBoth =
              archiveCalls.length === 1 &&
              ((archiveCalls[0].input as { threadIds?: string[] })?.threadIds
                ?.length ?? 0) >= 2;
            const bothArchived =
              archivedThreadIds(chatProvider).includes("thread-invoice-1") &&
              archivedThreadIds(otherProvider).includes("thread-renewal-1");
            const judge = finalText
              ? await judgeEvalOutput({
                  input: `${firstPrompt}\n(assistant lists the Acme emails, one in each account)\n${secondPrompt}`,
                  output: finalText,
                  expected:
                    "Both Acme emails were archived, each in the account it is in.",
                  criterion: {
                    name: "Archives both without talking about switching",
                    description:
                      "PASS only if the response says both Acme emails were archived and makes no claim that the user must switch accounts or chats, or that an email in another account could not be acted on. FAIL if it says only some were archived, asks the user to switch, or claims an email could not be changed because of its account.",
                  },
                })
              : null;

            return {
              pass:
                !firstTurnWrote &&
                oneCallForBoth &&
                bothArchived &&
                !!judge?.pass,
              actual: judge
                ? `${actual} | firstTurnWrote=${firstTurnWrote} | oneCallForBoth=${oneCallForBoth} | bothArchived=${bothArchived} | ${formatSemanticJudgeActual(finalText, judge)}`
                : `no assistant text | ${actual}`,
            };
          },
        );

        expect(record.pass, record.actual).toBe(true);
      },
      // Two turns.
      2 * TIMEOUT,
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

function invoiceEmail() {
  return getMockMessage({
    id: "msg-invoice-1",
    threadId: "thread-invoice-1",
    from: "Acme Billing <billing@acme.example>",
    to: "user@test.com",
    subject: "Acme invoice #4821",
    snippet: "Your October invoice is attached. Payment is due in 30 days.",
    textPlain:
      "Hello, your October invoice #4821 is attached. Payment is due in 30 days. Acme Billing",
  });
}

function archivedThreadIds(fake: ReturnType<typeof fakeProvider>) {
  return [
    ...fake.archiveThreadWithLabel.mock.calls,
    ...fake.moveThreadToFolder.mock.calls,
  ].map(([threadId]) => threadId as string);
}

// By default the chat's own account holds nothing about Acme; the user's
// other account holds the renewal email.
function mockAccounts({
  chatAccountId,
  chatAccountMessages = [],
  otherAccountMessages,
}: {
  chatAccountId: string;
  chatAccountMessages?: ReturnType<typeof getMockMessage>[];
  otherAccountMessages: ReturnType<typeof getMockMessage>[];
}) {
  const chatProvider = fakeProvider(chatAccountMessages);
  const otherProvider = fakeProvider(otherAccountMessages);

  const accounts = [
    {
      id: chatAccountId,
      email: "user@test.com",
      name: null,
      image: null,
      includeInAllAccounts: true,
      account: { provider: "google" },
    },
    {
      id: OTHER_ACCOUNT_ID,
      email: OTHER_ACCOUNT_EMAIL,
      name: null,
      image: null,
      includeInAllAccounts: true,
      account: { provider: "google" },
    },
  ];
  // As the database would: a lookup by id finds only that account.
  prisma.emailAccount.findMany.mockImplementation((async (args: {
    where?: { id?: string };
  }) =>
    accounts.filter(
      (account) => !args?.where?.id || account.id === args.where.id,
    )) as never);
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
