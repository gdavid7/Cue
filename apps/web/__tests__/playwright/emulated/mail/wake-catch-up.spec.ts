import { expect, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  insertInboxMailInConversation,
  openMail,
  readProviderAccessToken,
  waitForMetadataCoverage,
} from "./mail-test-helpers";

// A conversation both mailbox emulators hold, for new mail to arrive in.
const THREAD_ID = "thr_playwright_archive";
const MESSAGE_ID = "msg_playwright_archive";
const ARRIVAL_SUBJECT = "Arrived while the laptop slept";
const CATCH_UP_PATH = "/api/user/inbox-catch-up";

// RL-1c: a tab left open on a laptop that then slept. No timer ran while it
// was away, so the local mailbox fell behind; shown again, it catches up to
// the newest mail without a reload, reading it once for Gmail and leaving
// Outlook to its usual sync.
test("an inbox shown again after a long absence catches up without a reload", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const { conversations } = await openMail(page);
  await expect(conversations.getByRole("option").first()).toBeVisible();
  await waitForMetadataCoverage(page);

  const catchUps: number[] = [];
  const handedOver: string[] = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== CATCH_UP_PATH) return;
    catchUps.push(response.status());
    const body = (await response.json().catch(() => null)) as {
      changes?: { key?: { messageId?: string } }[];
    } | null;
    for (const change of body?.changes ?? [])
      if (change.key?.messageId) handedOver.push(change.key.messageId);
  });
  const loads = watchDocumentLoads(page);

  await setVisibility(page, "hidden");
  const insertedMessageId = await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    subject: ARRIVAL_SUBJECT,
    from: "arrivals@example.com",
  });
  try {
    // Moving the clock without running timers is a suspended tab.
    await page.clock.setSystemTime(Date.now() + 20 * 60_000);
    await setVisibility(page, "visible");

    await expect(
      conversationWithSubject(page, conversations, ARRIVAL_SUBJECT),
    ).toHaveCount(1, { timeout: 60_000 });
    expect(loads).toEqual([]);
    if (isMicrosoftPlaywright()) {
      await page.waitForTimeout(3000);
      expect(catchUps).toEqual([]);
    } else {
      // The row would show from the engine's own catch-up too; what proves
      // the wake read is that it ran once and carried the new message.
      await expect.poll(() => catchUps).toEqual([200]);
      await expect.poll(() => handedOver).toContain(insertedMessageId);
    }

    // Coming and going again shortly after is not another wake.
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await page.waitForTimeout(3000);
    expect(catchUps).toEqual(isMicrosoftPlaywright() ? [] : [200]);

    await capturePlaywrightCheckpoint(page, testInfo, "wake-catch-up-arrived");
  } finally {
    await deleteProviderMessage(page, insertedMessageId);
  }
});

// RL-1c2: the laptop slept with the inbox showing, so waking fires no
// visibility event; the clock having jumped past the tab's own ticks is the
// wake, caught up the same way.
test("an inbox left showing while the laptop slept catches up without a reload", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const { conversations } = await openMail(page);
  await expect(conversations.getByRole("option").first()).toBeVisible();
  await waitForMetadataCoverage(page);

  const catchUps: number[] = [];
  const handedOver: string[] = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== CATCH_UP_PATH) return;
    catchUps.push(response.status());
    const body = (await response.json().catch(() => null)) as {
      changes?: { key?: { messageId?: string } }[];
    } | null;
    for (const change of body?.changes ?? [])
      if (change.key?.messageId) handedOver.push(change.key.messageId);
  });
  const loads = watchDocumentLoads(page);

  const insertedMessageId = await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    subject: ARRIVAL_SUBJECT,
    from: "arrivals@example.com",
  });
  try {
    // Only the clock moves, and the tab never stops showing.
    await page.clock.setSystemTime(Date.now() + 20 * 60_000);

    await expect(
      conversationWithSubject(page, conversations, ARRIVAL_SUBJECT),
    ).toHaveCount(1, { timeout: 60_000 });
    expect(loads).toEqual([]);
    if (isMicrosoftPlaywright()) {
      // Past the next tick and its settle, which would have asked by now.
      await page.waitForTimeout(35_000);
      expect(catchUps).toEqual([]);
    } else {
      await expect.poll(() => catchUps, { timeout: 45_000 }).toEqual([200]);
      await expect.poll(() => handedOver).toContain(insertedMessageId);
    }

    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "wake-after-sleep-arrived",
    );
  } finally {
    await deleteProviderMessage(page, insertedMessageId);
  }
});

// Counts real document loads only. A background server action that refreshes
// the session cookie makes Next.js refresh the route and rewrite the same URL
// into history, which Playwright also reports as a navigation; that is not a
// reload and does not lose the page's state.
function watchDocumentLoads(page: Page) {
  const loads: string[] = [];
  page.on("load", (loaded) => loads.push(loaded.url()));
  return loads;
}

async function setVisibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: next,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: next === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function deleteProviderMessage(page: Page, messageId: string) {
  const token = await readProviderAccessToken();
  const url = isMicrosoftPlaywright()
    ? `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${messageId}`
    : `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${messageId}`;
  await page.request.delete(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
