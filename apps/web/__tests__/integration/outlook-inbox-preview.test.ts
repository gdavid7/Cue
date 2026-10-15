import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { loadInboxPreview } from "@/utils/threads/inbox-preview.server";
import { createOutlookTestHarness, type OutlookTestHarness } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const harnessRef = vi.hoisted(() => ({
  provider: undefined as unknown,
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: async () => harnessRef.provider,
}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const EMAIL = "preview@example.com";

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Outlook inbox preview",
  { timeout: 30_000 },
  () => {
    let harness: OutlookTestHarness;

    beforeAll(async () => {
      harness = await createOutlookTestHarness({
        email: EMAIL,
        messages: Array.from({ length: 3 }, (_, index) => ({
          conversation_id: `preview-thread-${index}`,
          user_email: EMAIL,
          from: { address: "sender@example.com" },
          to_recipients: [{ address: EMAIL }],
          subject: `Preview ${index}`,
          body_content: `Body ${index}`,
          parent_folder_id: "inbox",
          is_read: false,
          received_date_time: `2026-10-1${index}T12:00:00Z`,
        })),
      });
      harnessRef.provider = harness.provider;
    });

    beforeEach(() => {
      prisma.mailSplit.findMany.mockResolvedValue([]);
      prisma.mailSplit.findFirst.mockResolvedValue(null);
      prisma.executedRule.findMany.mockResolvedValue([]);
    });

    afterAll(async () => {
      harness?.restoreFetch();
      await harness?.emulator.close();
    });

    // The mail engine keys mail by Graph's conversation and message ids, so
    // the preview only stands in for the engine's first page if it uses them.
    it("lists the newest inbox conversations under the ids the mail engine uses", async () => {
      const graphInbox: {
        value: Array<{ id: string; conversationId: string }>;
      } = await harness.graphClient
        .api("/me/mailFolders/inbox/messages")
        .select("id,conversationId")
        .top(100)
        .get();
      const graphIds = new Map(
        graphInbox.value.map((message) => [message.conversationId, message.id]),
      );

      const startedAt = Date.now();
      const preview = await loadInboxPreview({
        emailAccountId: "account-1",
        provider: "microsoft",
      });

      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(preview?.threads.length).toBeGreaterThan(0);
      for (const thread of preview?.threads ?? []) {
        expect(graphIds.has(thread.id)).toBe(true);
        for (const message of thread.messages) {
          expect(message.threadId).toBe(thread.id);
          expect([...graphIds.values()]).toContain(message.id);
        }
      }
      expect(preview?.threads.map((thread) => thread.id)).toEqual(
        expect.arrayContaining([
          "preview-thread-2",
          "preview-thread-1",
          "preview-thread-0",
        ]),
      );
    });
  },
);
