import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailEngine,
} from "@inboxzero/mail-core/engine";
import type { MetadataChange } from "@inboxzero/mail-core/commands";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import {
  createGmailTestHarness,
  createOutlookTestHarness,
} from "@/__tests__/integration/helpers";
import { createTestLogger } from "@/__tests__/helpers";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";
import { createEmailProviderOperationExecutor } from "@/utils/mail-api/operations";
import { parsedMessageMetadata } from "@/utils/mail-api/observations";
import { submitConversationChanges } from "@/utils/mail-engine/submit-conversations";
import { undoConversationChange } from "@/utils/mail-engine/undo-change";
import type { EmailProvider } from "@/utils/email/types";

const { snoozedThreads, qstash, envOverrides } = vi.hoisted(() => ({
  snoozedThreads: [] as Array<Record<string, unknown>>,
  qstash: {
    published: [] as Array<{ label?: string }>,
    cancelledLabels: [] as string[],
  },
  envOverrides: { QSTASH_TOKEN: "qstash-test-token" } as Record<
    string,
    unknown
  >,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/email/local-mail-sync-budget", async (importActual) => {
  const { passThroughLocalMailSyncBudget } = await vi.importActual<
    typeof import("@/__tests__/integration/local-mail-sync-budget-mock")
  >("@/__tests__/integration/local-mail-sync-budget-mock");
  return passThroughLocalMailSyncBudget(importActual);
});
vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    env: new Proxy(actual.env, {
      get: (target, key: string) =>
        key in envOverrides
          ? envOverrides[key]
          : (target as Record<string, unknown>)[key],
    }),
  };
});
vi.mock("@upstash/qstash", () => ({
  Client: class {
    messages = {
      cancel: async ({ filter }: { filter: { label: string[] } }) => {
        qstash.cancelledLabels.push(...filter.label);
        return { cancelled: filter.label.length };
      },
    };
    publishJSON = async (message: { label?: string }) => {
      qstash.published.push(message);
      return { messageId: `qstash-${qstash.published.length}` };
    };
  },
}));
// The SnoozedThread table, in memory, so a test sees the record the server
// keeps for a snooze exactly as the scheduler leaves it.
vi.mock("@/utils/prisma", async () => {
  const { createInMemorySnoozedThreads } = await vi.importActual<
    typeof import("@/__tests__/integration/mail-engine/snooze-undo-store")
  >("@/__tests__/integration/mail-engine/snooze-undo-store");
  const snoozedThread = createInMemorySnoozedThreads(snoozedThreads);
  return {
    default: {
      snoozedThread,
      emailMessage: { updateMany: async () => ({ count: 0 }) },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    },
  };
});

const logger = createTestLogger();
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const HOUR_MS = 60 * 60 * 1000;
const SUBJECT = "Snooze me";

type ProviderSetup = {
  name: string;
  start: (input: { email: string; inInbox: boolean }) => Promise<{
    provider: EmailProvider;
    close: () => Promise<void>;
  }>;
};

const PROVIDERS: ProviderSetup[] = [
  {
    name: "Gmail",
    async start({ email, inInbox }) {
      const harness = await createGmailTestHarness({
        email,
        messages: [
          {
            id: "g-snooze-undo",
            user_email: email,
            from: "ada@example.com",
            to: email,
            subject: SUBJECT,
            body_text: "Later",
            label_ids: inInbox ? ["INBOX", "UNREAD"] : ["UNREAD"],
            internal_date: `${Date.now()}`,
          },
        ],
      });
      const restoreFetch = installGmailFetchRewrite(harness.emulator.url);
      return {
        provider: harness.provider,
        close: async () => {
          restoreFetch();
          await harness.emulator.close();
        },
      };
    },
  },
  {
    name: "Outlook",
    async start({ email, inInbox }) {
      const harness = await createOutlookTestHarness({
        email,
        messages: [
          {
            microsoft_id: "o-snooze-undo",
            conversation_id: "c-snooze-undo",
            user_email: email,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: email }],
            subject: SUBJECT,
            body_content: "Later",
            parent_folder_id: inInbox ? "inbox" : "archive",
            is_read: false,
            received_date_time: new Date().toISOString(),
          },
        ],
      });
      return {
        provider: harness.provider,
        close: async () => {
          harness.restoreFetch();
          await harness.emulator.close();
        },
      };
    },
  },
];

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "undoing a snooze through the mail engine",
  { timeout: 90_000 },
  () => {
    beforeEach(() => {
      snoozedThreads.length = 0;
      qstash.published.length = 0;
      qstash.cancelledLabels.length = 0;
    });

    describe.each(PROVIDERS)("$name", (setup) => {
      let running: Awaited<ReturnType<ProviderSetup["start"]>> | undefined;
      let engine: MailEngine | undefined;

      afterEach(async () => {
        await engine?.close();
        engine = undefined;
        await running?.close();
        running = undefined;
      });

      it("puts a sent snooze back: inbox, no snooze record and no scheduled return", async () => {
        const accountId = `${setup.name}-snooze-undo-sent`;
        running = await setup.start({
          email: `snooze-undo-sent-${setup.name}@example.com`,
          inInbox: true,
        });
        engine = await startEngine(accountId, running.provider);
        const conversationId = await onlyConversationId(engine);
        const before = await readState(engine, running.provider, accountId);
        expect(before.provider.roles).toContain("inbox");

        const snooze = await submit(engine, accountId, conversationId, {
          kind: "snooze",
          untilMs: Date.now() + HOUR_MS,
        });
        await engine.runUntil(Date.now() + 6000);

        const snoozed = await readState(engine, running.provider, accountId);
        expect(snoozed.provider.roles).not.toContain("inbox");
        expect(activeSnoozes()).toHaveLength(1);
        const [record] = activeSnoozes();
        expect(qstash.published.map((message) => message.label)).toEqual([
          `snoozed-thread-${record.id}`,
        ]);

        await undoConversationChange({
          client: engine,
          accountId,
          operationId: snooze,
          conversationIds: [conversationId],
          compensation: { kind: "unarchive" },
        });
        await engine.runUntil(Date.now() + 6000);

        expect(await readState(engine, running.provider, accountId)).toEqual(
          before,
        );
        expect(activeSnoozes()).toEqual([]);
        expect(qstash.cancelledLabels).toContain(`snoozed-thread-${record.id}`);
      });

      it("cancels a snooze still waiting in the engine before the server hears of it", async () => {
        const accountId = `${setup.name}-snooze-undo-queued`;
        running = await setup.start({
          email: `snooze-undo-queued-${setup.name}@example.com`,
          inInbox: true,
        });
        engine = await startEngine(accountId, running.provider);
        const conversationId = await onlyConversationId(engine);
        const before = await readState(engine, running.provider, accountId);

        const snooze = await submit(engine, accountId, conversationId, {
          kind: "snooze",
          untilMs: Date.now() + HOUR_MS,
        });
        await undoConversationChange({
          client: engine,
          accountId,
          operationId: snooze,
          conversationIds: [conversationId],
          compensation: { kind: "unarchive" },
        });
        await engine.runUntil(Date.now() + 6000);

        expect(await readState(engine, running.provider, accountId)).toEqual(
          before,
        );
        expect(snoozedThreads).toEqual([]);
        expect(qstash.published).toEqual([]);
      });

      it("leaves a conversation snoozed from outside the inbox out of it", async () => {
        const accountId = `${setup.name}-snooze-undo-archived`;
        running = await setup.start({
          email: `snooze-undo-archived-${setup.name}@example.com`,
          inInbox: false,
        });
        engine = await startEngine(accountId, running.provider);
        const conversationId = await onlyConversationId(engine);
        const before = await readState(engine, running.provider, accountId);
        expect(before.provider.roles).not.toContain("inbox");

        const snooze = await submit(engine, accountId, conversationId, {
          kind: "snooze",
          untilMs: Date.now() + HOUR_MS,
        });
        await engine.runUntil(Date.now() + 6000);
        expect(activeSnoozes()).toHaveLength(1);

        await undoConversationChange({
          client: engine,
          accountId,
          operationId: snooze,
          conversationIds: [conversationId],
          compensation: { kind: "archive" },
        });
        await engine.runUntil(Date.now() + 6000);

        expect(await readState(engine, running.provider, accountId)).toEqual(
          before,
        );
        expect(activeSnoozes()).toEqual([]);
      });
    });
  },
);

function activeSnoozes() {
  return snoozedThreads.filter((row) =>
    ["PREPARING", "PENDING", "EXECUTING"].includes(String(row.status)),
  );
}

async function startEngine(accountId: string, provider: EmailProvider) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId,
    provider: provider.name,
    generation: "gen-1",
  });
  const engine = createMailEngine({
    store,
    source: createEmailProviderMailboxSource({ logger, provider, accountId }),
    executor: createEmailProviderOperationExecutor({ provider, accountId }),
    runtime: createHostRuntime(),
  });
  await engine.requestSync([accountId]);
  await engine.runUntil(Date.now() + 8000);
  return engine;
}

async function onlyConversationId(engine: MailEngine) {
  const conversations = new Set(
    (await seededMessages(engine)).map((message) => message.conversationId),
  );
  expect(conversations.size).toBe(1);
  return [...conversations][0];
}

// The emulators seed mail of their own beside the conversation under test.
async function seededMessages(engine: MailEngine) {
  const { messages } = await engine.inspect();
  return messages.filter((message) => message.effective.subject === SUBJECT);
}

async function submit(
  engine: MailEngine,
  accountId: string,
  conversationId: string,
  change: MetadataChange,
) {
  const { accepted, rejectionCodes } = await submitConversationChanges({
    client: engine,
    accountId,
    conversationIds: [conversationId],
    change,
  });
  expect(rejectionCodes).toEqual([]);
  return accepted[0].commandId;
}

/** Where the conversation is, here and at the provider, and whether it's snoozed. */
async function readState(
  engine: MailEngine,
  provider: EmailProvider,
  accountId: string,
) {
  const local = (await seededMessages(engine)).filter(
    (message) => message.accountId === accountId,
  );
  expect(local).toHaveLength(1);
  const [message] = local;
  const remote = await provider.getThreadMessages(message.conversationId);
  return {
    local: {
      roles: [...message.effective.roles].sort(),
      snoozedUntilMs: message.effective.snoozedUntilMs ?? null,
      pending: message.effective.pendingOperationIds,
    },
    provider: {
      roles: [
        ...new Set(remote.flatMap((item) => parsedMessageMetadata(item).roles)),
      ].sort(),
    },
  };
}

function installGmailFetchRewrite(emulatorUrl: string) {
  const realFetch = globalThis.fetch;
  const emulatorOrigin = new URL(emulatorUrl).origin;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return realFetch(input, init);
    }
    if (parsed.hostname !== "gmail.googleapis.com")
      return realFetch(input, init);
    const rewritten = new URL(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      emulatorOrigin,
    ).href;
    if (input instanceof Request) {
      return realFetch(new Request(rewritten, input), init);
    }
    return realFetch(rewritten, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}
