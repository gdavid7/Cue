import type { Page } from "@playwright/test";
import {
  JOURNEY_SUBJECT_MARKER,
  type PlantedEmail,
} from "@/scripts/qa/journey-ground-truth";
import {
  appendInboxMessages,
  type QaMailboxCredentials,
  sendSelfMessage,
  trashMessagesWithSubject,
} from "@/scripts/qa/qa-mailbox";

// Where the journeys robot's mail comes from. In production it is the QA
// Gmail account over IMAP and SMTP; against the local emulated stack it is the
// Gmail emulator's API, see `emulated-mailbox.ts`.

export type DeliveryMethod = "append" | "smtp" | "insert";

export type OutgoingMessage = Pick<
  PlantedEmail,
  "subject" | "from" | "text"
> & {
  key: string;
  date?: Date;
};

export type JourneyMailbox = {
  self: string;
  /** Ways to deliver mail while the app watches; the first is the default. */
  deliveryMethods: DeliveryMethod[];
  /** Whether mail Cue sends to the account itself comes back to Inbox. */
  selfSendReachesInbox: boolean;
  /** How long to leave delivered mail before opening the app to look for it. */
  settleMs: number;
  deliver(
    runTag: string,
    messages: OutgoingMessage[],
    method: DeliveryMethod,
  ): Promise<void>;
  /** What the provider's push would do; nothing where push is real. */
  notifyApp(page: Page): Promise<void>;
  /** Trashes the run's mail, or with no tag every journey message left over. */
  removeJourneyMail(runTag?: string): Promise<number>;
  /** Readies a chat answer where the model is emulated. */
  prepareChatAnswer?(question: string, answer: string): Promise<void>;
};

export function createImapJourneyMailbox(
  credentials: QaMailboxCredentials,
): JourneyMailbox {
  return {
    self: credentials.email,
    deliveryMethods: ["append", "smtp"],
    selfSendReachesInbox: true,
    // Gmail lists new mail within seconds; this keeps a slow index from
    // reading as a slow app.
    settleMs: 20_000,
    async deliver(runTag, messages, method) {
      if (method === "smtp") {
        for (const message of messages) {
          await sendSelfMessage(credentials, {
            subject: message.subject,
            text: message.text,
            messageId: journeyMessageId(runTag, message.key),
          });
        }
        return;
      }
      await appendInboxMessages(
        credentials,
        messages.map((message) => ({
          ...message,
          messageId: journeyMessageId(runTag, message.key),
        })),
      );
    },
    async notifyApp() {},
    removeJourneyMail(runTag) {
      return trashMessagesWithSubject(credentials, [
        JOURNEY_SUBJECT_MARKER,
        ...(runTag ? [runTag] : []),
      ]);
    },
  };
}

function journeyMessageId(runTag: string, key: string) {
  return `<cue-qa-journey-${runTag}-${key}@cue-qa.invalid>`;
}
