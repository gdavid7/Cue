import { expect, type Locator, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  openMail,
  readLatestMailMutation,
} from "./mail-test-helpers";

// A touchscreen phone, so the drags below arrive as touch pointers and the
// browser applies the row's `touch-action`, as on an iPhone.
test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const SUBJECT = "Archive Action Message";
const THREAD = "thr_playwright_archive";

test("swipes a row left to archive it, and Undo brings it back", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(page, conversations, SUBJECT);
  await expect(row).toBeVisible();
  const swipe = await touchSwipe(page, row, { from: "right" });

  // Short of the commit point the action shows, muted, and nothing happens.
  await swipe.moveBy(-60);
  const track = page.locator('[data-swiping="archive"]');
  await expect(track).toBeVisible();
  await expect(track).not.toHaveAttribute("data-armed");
  await capturePlaywrightCheckpoint(page, testInfo, "swipe-archive-reveal");

  await swipe.moveBy(-150);
  await expect(track).toHaveAttribute("data-armed");
  await capturePlaywrightCheckpoint(page, testInfo, "swipe-archive-armed");
  await swipe.end();

  await expect(row).toHaveCount(0);
  await expectMutation(page, emailAccountId, "archive");
  // The keyboard's and toolbar's Undo, not a separate path.
  await page
    .getByRole("region", { name: "Notifications alt+T" })
    .getByRole("button", { name: /^Undo/ })
    .tap();
  await expect(row).toBeVisible();
  await expectMutation(page, emailAccountId, "unarchive");
  await expect(page.locator("[data-swiping]")).toHaveCount(0);
});

test("springs a row back when the swipe stops short", async ({ page }) => {
  const { conversations } = await openMail(page);
  const row = conversationWithSubject(page, conversations, SUBJECT);
  await expect(row).toBeVisible();

  const swipe = await touchSwipe(page, row, { from: "right" });
  await swipe.moveBy(-50, { steps: 10 });
  await swipe.pause();
  await swipe.end();

  await expect(page.locator("[data-swiping]")).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(row).toBeInViewport({ ratio: 1 });
});

test("swipes a row right to flip its read state", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(page, conversations, SUBJECT);
  await expect(row).toBeVisible();
  const wasUnread = await isUnread(row);

  const swipe = await touchSwipe(page, row, { from: "left" });
  await swipe.moveBy(200);
  await expect(page.locator('[data-swiping="toggleRead"]')).toHaveAttribute(
    "data-armed",
  );
  await capturePlaywrightCheckpoint(page, testInfo, "swipe-read-armed");
  await swipe.end();
  // The keyboard's and toolbar's read-state command, for the state shown.
  await expectReadState(page, emailAccountId, wasUnread);
  await expect.poll(() => isUnread(row)).toBe(!wasUnread);
  await expect(page.locator("[data-swiping]")).toHaveCount(0);

  // And back, leaving the shared mailbox as it was.
  const back = await touchSwipe(page, row, { from: "left" });
  await back.moveBy(200);
  await back.end();
  await expectReadState(page, emailAccountId, !wasUnread);
  await expect.poll(() => isUnread(row)).toBe(wasUnread);
});

test("leaves a vertical scroll to the list", async ({ page }) => {
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(page, conversations, SUBJECT);
  await expect(row).toBeVisible();
  const before = await readLatestMailMutation(page, {
    emailAccountId,
    kind: "archive",
    threadId: THREAD,
  });

  const swipe = await touchSwipe(page, row, { from: "center" });
  // Mostly upward, with the sideways drift of a real thumb.
  await swipe.moveBy(-30, { dy: -160 });
  await swipe.end();

  await expect(page.locator("[data-swiping]")).toHaveCount(0);
  await expect(row).toHaveCount(1);
  expect(
    await readLatestMailMutation(page, {
      emailAccountId,
      kind: "archive",
      threadId: THREAD,
    }),
  ).toEqual(before);
});

/**
 * A single finger dragged across `row` through Chromium's touch input, so the
 * page sees real touch pointers, touch-action and scrolling, which
 * `locator.tap()` and mouse drags don't exercise.
 */
async function touchSwipe(
  page: Page,
  row: Locator,
  { from }: { from: "left" | "center" | "right" },
) {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) throw new Error("Row is not visible");
  const cdp = await page.context().newCDPSession(page);
  // Room on the screen for the whole drag.
  let x = box.x + box.width * { left: 0.2, center: 0.5, right: 0.8 }[from];
  let y = box.y + box.height / 2;
  const point = () => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(),
  });

  return {
    async moveBy(dx: number, { dy = 0, steps = 12 } = {}) {
      const stepX = dx / steps;
      const stepY = dy / steps;
      for (let step = 0; step < steps; step++) {
        x += stepX;
        y += stepY;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(),
        });
        await page.waitForTimeout(16);
      }
    },
    /** Holds still, so the release carries no momentum. */
    async pause() {
      await page.waitForTimeout(200);
    },
    async end() {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
    },
  };
}

async function isUnread(row: Locator) {
  return ((await row.textContent()) ?? "").includes("Unread,");
}

async function expectMutation(
  page: Page,
  emailAccountId: string,
  kind: "archive" | "unarchive",
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind,
          threadId: THREAD,
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}

async function expectReadState(
  page: Page,
  emailAccountId: string,
  read: boolean,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_read_state",
          threadId: THREAD,
          payload: { read },
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}
