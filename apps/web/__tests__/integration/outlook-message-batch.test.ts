import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOutlookTestHarness, type OutlookTestHarness } from "./helpers";

vi.mock("server-only", () => ({}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const EMAIL = "message-batch@example.com";
const SUBJECTS = Array.from(
  { length: 6 },
  (_, index) => `Batch update ${index}`,
);

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Outlook message batch reads",
  { timeout: 30_000 },
  () => {
    let harness: OutlookTestHarness;
    let idsBySubject: Map<string, string>;

    beforeAll(async () => {
      harness = await createOutlookTestHarness({
        email: EMAIL,
        messages: SUBJECTS.map((subject, index) => ({
          conversation_id: `batch-thread-${index}`,
          user_email: EMAIL,
          from: { address: "sender@example.com" },
          to_recipients: [{ address: EMAIL }],
          subject,
          body_content: `Body ${index}`,
          parent_folder_id: "inbox",
          is_read: false,
          received_date_time: `2026-08-11T1${index}:00:00Z`,
        })),
      });
      const listed: { value: Array<{ id: string; subject: string }> } =
        await harness.graphClient
          .api("/me/messages")
          .select("id,subject")
          .top(100)
          .get();
      idsBySubject = new Map(
        listed.value.map((message) => [message.subject, message.id]),
      );
    });

    afterAll(async () => {
      harness?.restoreFetch();
      await harness?.emulator.close();
    });

    it("reads full messages through $batch and leaves out ones that are gone", async () => {
      const ids = SUBJECTS.map((subject) => idsBySubject.get(subject) ?? "");
      const requested = [
        ...ids.slice(0, 2),
        "missing-message",
        ...ids.slice(2),
      ];

      const messages = await harness.provider.getMessagesBatch(requested);

      expect(messages.map((message) => message.id)).toEqual(ids);
      expect(messages[0]).toMatchObject({
        subject: "Batch update 0",
        labelIds: expect.arrayContaining(["INBOX"]),
      });
      expect(messages[0].textHtml ?? messages[0].textPlain).toContain("Body 0");
    });
  },
);
