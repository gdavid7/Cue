import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
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

const OUTLOOK_SKIP =
  "Notifying is provider-neutral; the Outlook emulator needs a real message id to reply to.";

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
  test.skip(isMicrosoftPlaywright(), OUTLOOK_SKIP);
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
  test.skip(isMicrosoftPlaywright(), OUTLOOK_SKIP);
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

test("pauses from the command palette and resumes from it", async ({
  page,
}, testInfo) => {
  await stubBrowser(page, { permission: "granted", holdsLock: true });
  await openMail(page);

  await pauseForAnHourFromPalette(page);
  await expect.poll(() => quietUntilMs(page)).not.toBeNull();
  // A pause is not "off": the mode stays, so the off reminder stays away.
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("cue:web-notifications:mode"),
    ),
  ).toBe("all");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Type a command or search...").fill("resume");
  const resume = page.getByRole("option", { name: /Resume notifications/ });
  await expect(resume).toContainText("Paused until");
  await capturePlaywrightCheckpoint(page, testInfo, "palette-while-paused");
  await resume.click();

  await expect.poll(() => quietUntilMs(page)).toBeNull();
});

test("pauses from Settings, with a moon while paused", async ({
  page,
}, testInfo) => {
  await stubBrowser(page, { permission: "granted", holdsLock: true });
  await page.goto("/settings");
  const pauseButton = page.getByRole("button", { name: "Pause…" });
  await waitUntilStill(pauseButton);

  await pauseButton.click();
  await page
    .getByRole("dialog", { name: "Pause notifications until" })
    .getByRole("button", { name: /Until (tomorrow|this) morning/ })
    .click();

  await expect(page.getByText(/^Paused until /)).toBeVisible();
  await expect(page.getByRole("img", { name: "Paused" })).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "settings-while-paused");

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause…" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Paused" })).toHaveCount(0);
  expect(await quietUntilMs(page)).toBeNull();
});

test("holds back mail during a pause set in another tab, then resumes on its own", async ({
  page,
}) => {
  test.skip(isMicrosoftPlaywright(), OUTLOOK_SKIP);
  await stubBrowser(page, { permission: "granted", holdsLock: true });
  const { conversations } = await openMail(page);
  await waitForMetadataCoverage(page);
  await expect
    .poll(() => lockRequests(page), { timeout: 60_000 })
    .toContain("cue:web-notifier");

  // The pause is chosen in a second tab, which waits for the notifier lock.
  const otherTab = await page.context().newPage();
  await stubBrowser(otherTab, { permission: "granted", holdsLock: false });
  await openMail(otherTab);
  await pauseForAnHourFromPalette(otherTab);
  await expect.poll(() => quietUntilMs(page)).not.toBeNull();

  await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: "msg_playwright_web_notification_paused",
    subject: SUBJECT,
    from: "Paused Sender <paused@example.com>",
  });
  await requestMailSync(page);
  // The list and the notifier read the same mailbox, so once the list shows
  // the mail the notifier has seen it too.
  await expect(conversations.getByText("Paused Sender").first()).toBeVisible({
    timeout: 60_000,
  });
  expect(await shownNotifications(page)).toEqual([]);

  // Shorten the pause from the other tab and let it run out, with no further
  // write from any tab.
  await otherTab.evaluate(() =>
    window.localStorage.setItem(
      "cue:web-notifications:quiet-until",
      String(Date.now() + 2000),
    ),
  );
  await page.waitForTimeout(3000);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Type a command or search...").fill("pause");
  await expect(
    page.getByRole("option", { name: /Pause notifications…/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await insertInboxMailInConversation(page, {
    threadId: THREAD_ID,
    messageId: "msg_playwright_web_notification_resumed",
    subject: SUBJECT,
    from: "Resumed Sender <resumed@example.com>",
  });
  await requestMailSync(page);

  await expect
    .poll(() => shownNotifications(page), { timeout: 60_000 })
    .toEqual([expect.objectContaining({ title: "Resumed Sender" })]);
  await otherTab.close();
});

async function pauseForAnHourFromPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Type a command or search...").fill("pause");
  await page.getByRole("option", { name: /Pause notifications…/ }).click();
  await expect(
    page.getByRole("group", { name: "Pause notifications" }),
  ).toBeVisible();
  await page.getByRole("option", { name: /For 1 hour/ }).click();
}

// Settings fills in the account list and billing after first paint, pushing
// the rows below them down. A popover opened before that follows its trigger
// off screen, so wait for the trigger to stop moving.
async function waitUntilStill(locator: Locator) {
  const offsetInPage = () =>
    locator.evaluate((element) => {
      let top = 0;
      for (
        let node = element as HTMLElement | null;
        node;
        node = node.offsetParent as HTMLElement | null
      )
        top += node.offsetTop;
      return top;
    });
  await expect
    .poll(
      async () => {
        const before = await offsetInPage();
        await locator.page().waitForTimeout(1000);
        return (await offsetInPage()) === before;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

function quietUntilMs(page: Page) {
  return page.evaluate(() => {
    const value = Number(
      window.localStorage.getItem("cue:web-notifications:quiet-until"),
    );
    return value > Date.now() ? value : null;
  });
}

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
