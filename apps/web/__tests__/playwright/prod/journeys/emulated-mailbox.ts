import type { Page } from "@playwright/test";
import {
  readProviderAccessToken,
  requestMailSync,
} from "../../emulated/mail/mail-test-helpers";
import type { JourneyMailbox } from "./journey-mailbox";

// The journeys robot's mailbox on the local emulated stack: mail goes in
// through the Gmail emulator's API, and since the emulator has no Pub/Sub,
// "push" is the Gmail webhook posted by hand plus a sync request. Timings here
// check the journeys' logic, not production speed.

export function createEmulatorJourneyMailbox(): JourneyMailbox {
  const self = process.env.PLAYWRIGHT_TEST_EMAIL;
  const gmail = process.env.GOOGLE_BASE_URL;
  const llm = process.env.PLAYWRIGHT_LLM_BASE_URL;
  if (!self || !gmail || !llm) {
    throw new Error(
      "The emulated journeys need the Playwright config's PLAYWRIGHT_TEST_EMAIL, GOOGLE_BASE_URL and PLAYWRIGHT_LLM_BASE_URL",
    );
  }
  const created: string[] = [];
  const api = async (path: string, init: RequestInit = {}) => {
    const token = await readProviderAccessToken();
    const response = await fetch(`${gmail}/gmail/v1/users/me${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Gmail emulator ${path} answered ${response.status}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  };
  return {
    self,
    deliveryMethods: ["insert"],
    selfSendReachesInbox: false,
    settleMs: 1000,
    async deliver(_runTag, messages) {
      for (const message of messages) {
        const inserted = await api("/messages", {
          method: "POST",
          body: JSON.stringify({
            from: message.from.address,
            to: self,
            subject: message.subject,
            body_text: message.text,
            labelIds: ["INBOX", "UNREAD"],
            internalDate: String((message.date ?? new Date()).getTime()),
          }),
        });
        if (typeof inserted.id === "string") created.push(inserted.id);
      }
    },
    async notifyApp(page: Page) {
      const { historyId } = await api("/profile");
      await page.request
        .post(
          `/api/google/webhook?token=${encodeURIComponent(process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN ?? "playwright-token")}`,
          {
            data: {
              message: {
                data: Buffer.from(
                  JSON.stringify({
                    emailAddress: self,
                    historyId: String(historyId),
                  }),
                ).toString("base64"),
              },
            },
          },
        )
        .catch(() => undefined);
      await requestMailSync(page);
    },
    async removeJourneyMail() {
      let removed = 0;
      for (const id of created.splice(0)) {
        await api(`/messages/${id}/trash`, { method: "POST" })
          .then(() => {
            removed += 1;
          })
          .catch(() => undefined);
      }
      return removed;
    },
    async prepareChatAnswer(question, answer) {
      const response = await fetch(`${llm}/__emulator/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ match: question, text: answer }),
      });
      if (!response.ok) {
        throw new Error(`LLM emulator refused the reply (${response.status})`);
      }
    },
  };
}
