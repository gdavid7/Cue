import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  insertInboxMailInConversation,
  openMail,
  requestMailSync,
  waitForMetadataCoverage,
} from "./mail-test-helpers";

const THREAD_ID = "thr_playwright_archive";
const SUBJECT = "Archive Action Message";

type StubbedBrowser = {
  shown: Array<{ title: string; body?: string }>;
  lockRequests: string[];
};

declare global {
  interface Window {
    __playwrightNotifications?: StubbedBrowser;
  }
}

test.describe.configure({ mode: "serial" });

test("shows the unread count in the tab title", async ({ page }, testInfo) => {
  await openMail(page);
  await expect
    .poll(() => page.title(), { timeout: 60_000 })
    .toMatch(/^Inbox \(\d+\+?\) – \S/);
  await capturePlaywrightCheckpoint(page, testInfo, "tab-title-unread-count");
});

test("notifies about new mail from the tab that holds the lock", async ({
  page,
}, testInfo) => {
  await stubBrowser(page, { permission: "granted", holdsLock: true });
  await openMail(page);
  await waitForMetadataCoverage(page);
  await expect
    .poll(() => lockRequests(page), { timeout: 60_000 })
    .toContain("cue:web-notifier");

  await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: "msg_playwright_web_notification",
    subject: SUBJECT,
    from: "Erin Example <erin@example.com>",
  });
  await requestMailSync(page);

  await expect
    .poll(() => shownNotifications(page), { timeout: 60_000 })
    .toEqual([expect.objectContaining({ title: "Erin Example" })]);
  expect((await shownNotifications(page))[0]?.body).toBe(SUBJECT);
  await capturePlaywrightCheckpoint(page, testInfo, "web-notification-shown");
});

test("stays quiet in a tab that is waiting for the lock", async ({ page }) => {
  await stubBrowser(page, { permission: "granted", holdsLock: false });
  await openMail(page);
  await waitForMetadataCoverage(page);
  await expect
    .poll(() => lockRequests(page), { timeout: 60_000 })
    .toContain("cue:web-notifier");

  await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: "msg_playwright_web_notification_follower",
    subject: SUBJECT,
    from: "Erin Example <erin@example.com>",
  });
  await requestMailSync(page);

  await page.waitForTimeout(3000);
  expect(await shownNotifications(page)).toEqual([]);
});

test("does not watch for new mail when the browser blocks notifications", async ({
  page,
}) => {
  await stubBrowser(page, { permission: "denied", holdsLock: true });
  await openMail(page);
  await waitForMetadataCoverage(page);

  await page.waitForTimeout(1000);
  expect(await lockRequests(page)).toEqual([]);
  expect(await shownNotifications(page)).toEqual([]);
});

// The real Notification and Web Locks APIs depend on the browser profile and
// on other open tabs, so the page gets stand-ins it can observe.
async function stubBrowser(
  page: Page,
  input: { permission: NotificationPermission; holdsLock: boolean },
) {
  await page.addInitScript((stub) => {
    const state: StubbedBrowser = { shown: [], lockRequests: [] };
    window.__playwrightNotifications = state;
    window.localStorage.setItem("cue:web-notifications:mode", "all");

    class StubNotification {
      static permission = stub.permission;
      static requestPermission() {
        return Promise.resolve(stub.permission);
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        state.shown.push({ title, body: options?.body });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", {
      value: StubNotification,
      configurable: true,
      writable: true,
    });

    // The mail engine takes its own locks, so only the notifier's is stubbed.
    const realLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request(
          name: string,
          options: LockOptions,
          callback: (lock: unknown) => Promise<unknown>,
        ) {
          if (name !== "cue:web-notifier")
            return realLocks.request(name, options, callback);
          state.lockRequests.push(name);
          // A tab that doesn't hold the lock waits in the queue.
          return stub.holdsLock ? callback({ name }) : new Promise(() => {});
        },
      },
    });

    // Cue only notifies when no tab is in front of the reader.
    document.hasFocus = () => false;
  }, input);
}

function shownNotifications(page: Page) {
  return page.evaluate(() => window.__playwrightNotifications?.shown ?? []);
}

function lockRequests(page: Page) {
  return page.evaluate(
    () => window.__playwrightNotifications?.lockRequests ?? [],
  );
}
