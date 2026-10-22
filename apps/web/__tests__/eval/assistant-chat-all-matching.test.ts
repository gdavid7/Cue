import type { ModelMessage } from "ai";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailClient,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { describeEvalMatrix } from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  formatSemanticJudgeActual,
  judgeEvalOutput,
} from "@/__tests__/eval/semantic-judge";
import { getMockMessage } from "@/__tests__/helpers";
import {
  mockEnqueueMailBulkJob,
  mockGetMessage,
  mockListMatchingMessages,
  mockSearchMessages,
  runAssistantChat,
  setupInboxWorkflowEval,
  shouldRunEval,
  TIMEOUT,
} from "@/__tests__/eval/assistant-chat-inbox-workflows-test-utils";
import type { RecordedToolCall } from "@/__tests__/eval/assistant-chat-eval-utils";
import { countLocalMail } from "@/utils/mail-engine/assistant-count";
import type { LocalCountSearch } from "@/utils/actions/assistant-local-search.validation";

// pnpm test-ai eval/assistant-chat-all-matching
// Questions and actions about all of a mailbox's matching mail, not one page.

const evalReporter = createEvalReporter({
  evalName: "assistant-chat-all-matching",
});

const ACCOUNT_ID = "email-account-id";
const USER_EMAIL = "user@test.com";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date();
const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const lastYear = now.getUTCFullYear() - 1;

const ADA = "Ada Lovelace <ada@lovelace.example>";
const SHOP = "Shop News <news@shop.example>";
const DIGEST = "Medium Daily Digest <digest@medium.example>";
const ADA_THIS_MONTH = 137;

// Newsletters from last year still in the inbox, as the job would list them.
const NEWSLETTER_THREADS = 1204;
const NEWSLETTER_MESSAGES = 2318;

type FixtureMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAtMs: number;
  roles: Array<"inbox" | "sent">;
  categoryIds: string[];
};

const mailbox = buildMailbox();

describe.runIf(shouldRunEval)("Eval: assistant chat all matching mail", () => {
  setupInboxWorkflowEval();
  let local: Awaited<ReturnType<typeof localStoreWith>>;

  beforeAll(async () => {
    local = await localStoreWith(mailbox);
  });

  afterAll(async () => {
    await local?.close();
    evalReporter.printReport();
  });

  beforeEach(() => {
    // The provider's own search, as searchInbox reads it: 20 at a time.
    mockSearchMessages.mockImplementation(
      async (input: {
        query?: string;
        pageToken?: string;
        maxResults?: number;
      }) =>
        searchFixture({
          ...input,
          maxResults: Math.min(input.maxResults ?? 20, 20),
        }),
    );
    mockGetMessage.mockImplementation(async (id: string) => toParsed(byId(id)));
    // What a select-all job lists: archiving reads the inbox's matches.
    mockListMatchingMessages.mockImplementation(
      async ({
        scope,
        only,
        pageToken,
      }: {
        scope: { q?: string };
        only: { inInbox?: boolean };
        pageToken?: string;
      }) => {
        if (only.inInbox) return newsletterListing(pageToken);
        const page = searchFixture({
          query: scope.q,
          pageToken,
          maxResults: 500,
        });
        return {
          messages: page.messages.map(({ id, threadId }) => ({ id, threadId })),
          nextPageToken: page.nextPageToken,
        };
      },
    );
  });

  describeEvalMatrix("assistant-chat all matching", (model, emailAccount) => {
    test(
      "answers how many emails came from a sender this month with the exact count",
      async () => {
        const prompt =
          "How many emails did I get from ada@lovelace.example this month?";
        const { toolCalls, finalText, actual } = await runAssistantChat({
          emailAccount,
          messages: [{ role: "user", content: prompt }],
          localMailSearch: local.search,
        });

        const counted = calls(toolCalls, "countEmails");
        const judged = await judgeEvalOutput({
          input: prompt,
          output: finalText,
          expected: `${ADA_THIS_MONTH} emails from Ada this month`,
          criterion: {
            name: "Exact count",
            description: `The reply gives ${ADA_THIS_MONTH} as the exact number of emails from this sender this month. It must not give a different number, a number limited by a page of search results (such as 20), or say the total is unknown.`,
          },
        });
        const pass = counted.length > 0 && judged.pass;

        evalReporter.record({
          testName: "exact count for a sender this month",
          model: model.label,
          pass,
          actual: `${actual} | ${formatSemanticJudgeActual(finalText, judged)}`,
        });
        expect(pass, `${actual} | ${judged.reasoning}`).toBe(true);
      },
      TIMEOUT,
    );

    test(
      "lists who emails the user the most from counts over all their mail",
      async () => {
        const prompt = "Who emails me the most?";
        const { toolCalls, finalText, actual } = await runAssistantChat({
          emailAccount,
          messages: [{ role: "user", content: prompt }],
          localMailSearch: local.search,
        });

        const grouped = calls(toolCalls, "countEmails").filter(
          (call) => (call.input as { groupBy?: unknown }).groupBy === "sender",
        );
        const judged = await judgeEvalOutput({
          input: prompt,
          output: finalText,
          expected: `1. Shop News (news@shop.example), ${count(SHOP)}; 2. Medium Daily Digest (digest@medium.example), ${count(DIGEST)}; 3. Ada Lovelace (ada@lovelace.example), ${count(ADA)}`,
          criterion: {
            name: "Correct top senders",
            description:
              "The reply ranks the top senders in the expected order with their expected counts. It does not invent senders or counts, does not list the user's own address as a sender, and does not present a sample of recent emails as the ranking.",
          },
        });
        const pass = grouped.length > 0 && judged.pass;

        evalReporter.record({
          testName: "top senders",
          model: model.label,
          pass,
          actual: `${actual} | ${formatSemanticJudgeActual(finalText, judged)}`,
        });
        expect(pass, `${actual} | ${judged.reasoning}`).toBe(true);
      },
      TIMEOUT,
    );

    test(
      "shows the count and asks before archiving everything matching, then starts the job once confirmed",
      async () => {
        const prompt = "Archive all newsletters from last year.";
        const first = await runAssistantChat({
          emailAccount,
          messages: [{ role: "user", content: prompt }],
          localMailSearch: local.search,
        });
        const startedBeforeConfirming =
          mockEnqueueMailBulkJob.mock.calls.length;
        const previews = calls(first.toolCalls, "manageInbox").filter(
          (call) =>
            (call.output as { status?: unknown } | undefined)?.status ===
            "needs_confirmation",
        );
        const previewQuery = String(
          (previews[0]?.input as { query?: unknown } | undefined)?.query ?? "",
        );
        const [askedJudge, queryJudge] = await Promise.all([
          judgeEvalOutput({
            input: prompt,
            output: first.finalText,
            expected: `About ${NEWSLETTER_THREADS.toLocaleString("en-US")} conversations would be archived; asks the user to confirm`,
            criterion: {
              name: "Shows the count and asks first",
              description:
                "Before anything is archived, the reply tells the user how many conversations (or emails) would be archived, using the counted number, and asks them to confirm. It does not say anything was archived yet.",
            },
          }),
          judgeEvalOutput({
            input: prompt,
            output: previewQuery,
            expected: `A search for newsletter or promotional mail received during ${lastYear}`,
            criterion: {
              name: "Search scope",
              description:
                "The search semantically targets newsletters or promotional mail from last calendar year, not a wider or unrelated set.",
            },
          }),
        ]);

        const second = await runAssistantChat({
          emailAccount,
          messages: [
            { role: "user", content: prompt },
            ...first.responseMessages,
            { role: "user", content: "Yes, go ahead." } as ModelMessage,
          ],
          localMailSearch: local.search,
        });
        const started = calls(second.toolCalls, "manageInbox").some(
          (call) =>
            (call.output as { status?: unknown } | undefined)?.status ===
            "started",
        );
        const startedJudge = await judgeEvalOutput({
          input: `${prompt}\n(assistant asked to confirm)\nYes, go ahead.`,
          output: second.finalText,
          criterion: {
            name: "Reports the started job honestly",
            description:
              "The reply says archiving has started for the matching conversations. It does not claim every conversation is already archived or invent a different count.",
          },
        });

        const pass =
          startedBeforeConfirming === 0 &&
          previews.length > 0 &&
          askedJudge.pass &&
          queryJudge.pass &&
          started &&
          mockEnqueueMailBulkJob.mock.calls.length === 1 &&
          startedJudge.pass;

        const detail = [
          `turn1=${first.actual}`,
          `query=${previewQuery}`,
          `ask=${askedJudge.pass ? "PASS" : `FAIL (${askedJudge.reasoning})`}`,
          `scope=${queryJudge.pass ? "PASS" : `FAIL (${queryJudge.reasoning})`}`,
          `turn2=${second.actual}`,
          `jobs=${mockEnqueueMailBulkJob.mock.calls.length}`,
          `report=${startedJudge.pass ? "PASS" : `FAIL (${startedJudge.reasoning})`}`,
        ].join(" | ");
        evalReporter.record({
          testName: "archive all matching: count, confirm, start",
          model: model.label,
          pass,
          actual: detail,
        });
        expect(pass, detail).toBe(true);
      },
      TIMEOUT * 2,
    );

    test(
      "doesn't start a bulk job over a search without the user's confirmation",
      async () => {
        const prompt = "Mark every unread email from last year as read.";
        const { finalText, actual } = await runAssistantChat({
          emailAccount,
          messages: [{ role: "user", content: prompt }],
          localMailSearch: local.search,
        });

        const judged = await judgeEvalOutput({
          input: prompt,
          output: finalText,
          criterion: {
            name: "Asks before a bulk change",
            description:
              "The reply does not claim that every matching email was marked as read. If it describes a pending change over many emails, it gives the number that would change and asks the user to confirm before doing it.",
          },
        });
        const pass =
          mockEnqueueMailBulkJob.mock.calls.length === 0 && judged.pass;

        evalReporter.record({
          testName: "no bulk job without confirmation",
          model: model.label,
          pass,
          actual: `${actual} | jobs=${mockEnqueueMailBulkJob.mock.calls.length} | ${formatSemanticJudgeActual(finalText, judged)}`,
        });
        expect(pass, `${actual} | ${judged.reasoning}`).toBe(true);
      },
      TIMEOUT,
    );
  });
});

function calls(toolCalls: RecordedToolCall[], toolName: string) {
  return toolCalls.filter((call) => call.toolName === toolName);
}

function count(from: string) {
  return mailbox.filter(
    (message) => message.from === from && message.roles.includes("inbox"),
  ).length;
}

function buildMailbox(): FixtureMessage[] {
  const messages: FixtureMessage[] = [];
  const add = (
    from: string,
    receivedAtMs: number,
    fields: Partial<FixtureMessage> = {},
  ) => {
    const index = messages.length;
    messages.push({
      id: `msg-${index}`,
      threadId: `thread-${index}`,
      from,
      subject: `Update ${index}`,
      receivedAtMs,
      roles: ["inbox"],
      categoryIds: [],
      ...fields,
    });
  };

  // Ada this month, from a day into it (so no time zone moves one out) to
  // an hour ago, and before it.
  const monthSpan = Math.max(HOUR, now.getTime() - monthStart - DAY - HOUR);
  for (let i = 0; i < ADA_THIS_MONTH; i++)
    add(ADA, monthStart + DAY + Math.floor((monthSpan * i) / ADA_THIS_MONTH));
  for (let i = 0; i < 60; i++) add(ADA, monthStart - (i + 1) * 3 * DAY);
  // The biggest senders, over the last two years.
  for (let i = 0; i < 640; i++)
    add(SHOP, now.getTime() - i * 27 * HOUR - 7 * HOUR, {
      categoryIds: ["CATEGORY_PROMOTIONS"],
    });
  for (let i = 0; i < 410; i++)
    add(DIGEST, now.getTime() - i * 43 * HOUR - 5 * HOUR, {
      categoryIds: ["CATEGORY_PROMOTIONS"],
    });
  for (let sender = 0; sender < 30; sender++)
    for (let i = 0; i < 6; i++)
      add(
        `Person ${sender} <person${sender}@example.com>`,
        now.getTime() - (sender * 6 + i) * 2 * DAY,
      );
  // The user's own sent mail is not someone emailing them.
  for (let i = 0; i < 900; i++)
    add(`Test User <${USER_EMAIL}>`, now.getTime() - i * 9 * HOUR, {
      roles: ["sent"],
    });

  return messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
}

function byId(id: string) {
  const message = mailbox.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`Unexpected messageId: ${id}`);
  return message;
}

function toParsed(message: FixtureMessage) {
  return {
    ...getMockMessage({
      id: message.id,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      snippet: "Here is the latest.",
      labelIds: [
        ...(message.roles.includes("inbox") ? ["INBOX"] : ["SENT"]),
        ...message.categoryIds,
      ],
    }),
    date: new Date(message.receivedAtMs).toISOString(),
  };
}

// Gmail's own search, roughly: an exact sender and after: dates, newest first.
function searchFixture({
  query = "",
  pageToken,
  maxResults = 20,
}: {
  query?: string;
  pageToken?: string;
  maxResults?: number;
}) {
  const from = query.match(/from:(\S+)/i)?.[1]?.toLowerCase();
  const after = query.match(/after:(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const afterMs = after
    ? Date.UTC(Number(after[1]), Number(after[2]) - 1, Number(after[3]))
    : null;
  const matches = mailbox.filter(
    (message) =>
      (!from || message.from.toLowerCase().includes(from)) &&
      (afterMs === null || message.receivedAtMs >= afterMs),
  );
  const start = pageToken ? Number(pageToken) || 0 : 0;
  const size = maxResults;
  const page = matches.slice(start, start + size);
  return {
    messages: page.map(toParsed),
    nextPageToken:
      start + size < matches.length ? String(start + size) : undefined,
  };
}

function newsletterListing(pageToken?: string) {
  const all = Array.from({ length: NEWSLETTER_MESSAGES }, (_, index) => ({
    id: `newsletter-${index}`,
    threadId: `newsletter-thread-${index < (NEWSLETTER_MESSAGES - NEWSLETTER_THREADS) * 2 ? Math.floor(index / 2) : index - (NEWSLETTER_MESSAGES - NEWSLETTER_THREADS)}`,
  }));
  const start = pageToken ? Number(pageToken) : 0;
  const end = Math.min(all.length, start + 500);
  return {
    messages: all.slice(start, end),
    nextPageToken: end < all.length ? String(end) : undefined,
  };
}

/**
 * The chat's browser: the real local store holding the fixture mailbox, and
 * the real count the browser makes from it.
 */
async function localStoreWith(messages: FixtureMessage[]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: ACCOUNT_ID,
    provider: "google",
    generation: "g1",
  });
  const changes = messages.map((message) => ({
    kind: "message_patch" as const,
    key: { accountId: ACCOUNT_ID, messageId: message.id },
    reference: {
      provider: "google" as const,
      messageId: message.id,
      conversationId: message.threadId,
      version: "1",
    },
    fields: {
      subject: message.subject,
      preview: "Here is the latest.",
      from: message.from,
      to: [USER_EMAIL],
      cc: [],
      receivedAtMs: message.receivedAtMs,
      read: true,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: message.categoryIds,
      roles: message.roles,
      hasAttachments: false,
    },
  }));
  for (let start = 0; start < changes.length; start += 1000) {
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session: { accountId: ACCOUNT_ID, generation: "g1" },
        requestId: `boot-${start}`,
        from: {
          streamId: "primary",
          generation: "g1",
          checkpoint: start === 0 ? null : String(start),
        },
        to: {
          streamId: "primary",
          generation: "g1",
          checkpoint: String(start + 1000),
        },
        changes: changes.slice(start, start + 1000),
        requiredHydration: [],
        roundComplete: start + 1000 >= changes.length,
      },
    });
  }
  const engine = createMailEngine({
    store,
    source: idleSource(),
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime(),
  });
  // The whole fixture mailbox is synced.
  const client: MailClient = {
    ...engine,
    searchMessages: async (query) => {
      const page = await engine.searchMessages!(query);
      return {
        ...page,
        coverage: page.coverage.map((item) => ({
          ...item,
          metadata: "complete" as const,
          indexedContent: "complete" as const,
          windowStartMs: null,
        })),
      };
    },
  };

  return {
    search: {
      search: async () => null,
      count: async ({
        searches,
        groupBy,
      }: {
        searches: LocalCountSearch[];
        groupBy?: "sender" | "month" | "week" | "label";
      }) => {
        const result = await countLocalMail({ client, searches, groupBy });
        return result.status === "counted" ? result : null;
      },
    },
    close: () => engine.close(),
  };
}

function idleSource(): MailboxSource {
  const paused = {
    status: "paused" as const,
    retryAfterMs: 60_000,
    reason: "unavailable" as const,
  };
  return {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: [],
          maxPageSize: 10,
          maxHydrationBatch: 10,
        },
      };
    },
    async discoverScopes() {
      return { status: "ok", value: { scopes: [], nextPage: null } };
    },
    async beginBootstrap() {
      return paused;
    },
    async enumerate() {
      return paused;
    },
    async readChanges() {
      return paused;
    },
    async hydrate() {
      return paused;
    },
    async readConversationMembership() {
      return paused;
    },
    async search() {
      return paused;
    },
  } as unknown as MailboxSource;
}
