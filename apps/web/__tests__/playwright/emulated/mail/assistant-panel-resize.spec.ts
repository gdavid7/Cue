import { expect, type Locator, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

const DEFAULT_WIDTH = 450;

test("drags the assistant panel wider, keeps the width after reload, and resets on double-click", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const { conversations } = await openMail(page);

  const handle = await openAssistantPanel(page);
  await expect(handle).toHaveAttribute("aria-valuenow", String(DEFAULT_WIDTH));

  const box = await settledBox(handle);
  const grabX = box.x + box.width / 2;
  const grabY = box.y + box.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 100, grabY, { steps: 5 });
  await page.mouse.move(grabX - 200, grabY, { steps: 5 });
  await page.mouse.up();

  const widened = DEFAULT_WIDTH + 200;
  await expect(handle).toHaveAttribute("aria-valuenow", String(widened));
  await expectPanelWidth(page, widened);
  await expectMailReflowed(page, conversations, widened);
  await capturePlaywrightCheckpoint(page, testInfo, "assistant-panel-widened");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "assistant-panel-widened-dark",
  );
  await page.emulateMedia({ colorScheme: "light" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  const reopened = await openAssistantPanel(page);
  await expect(reopened).toHaveAttribute("aria-valuenow", String(widened));
  await expectPanelWidth(page, widened);

  await reopened.focus();
  await page.keyboard.press("ArrowRight");
  await expect(reopened).toHaveAttribute("aria-valuenow", String(widened - 16));
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "assistant-panel-handle-focused",
  );

  await reopened.dblclick();
  await expect(reopened).toHaveAttribute(
    "aria-valuenow",
    String(DEFAULT_WIDTH),
  );
  await expectPanelWidth(page, DEFAULT_WIDTH);
  await expectMailReflowed(page, conversations, DEFAULT_WIDTH);
});

test("keeps the assistant full screen on phones, with no resize handle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMail(page);

  await page.getByRole("button", { name: "Ask Cue" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Cue" }),
  ).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "Resize assistant panel" }),
  ).toBeHidden();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

async function openAssistantPanel(page: Page) {
  await page.getByRole("button", { name: "Ask Cue" }).click();
  const handle = page.getByRole("separator", {
    name: "Resize assistant panel",
  });
  await expect(handle).toBeVisible();
  return handle;
}

async function expectPanelWidth(page: Page, width: number) {
  const panel = page
    .getByRole("separator", { name: "Resize assistant panel" })
    .locator("..");
  await expect
    .poll(async () => Math.round((await panel.boundingBox())?.width ?? 0))
    .toBe(width);
}

async function expectMailReflowed(
  page: Page,
  conversations: Locator,
  panelWidth: number,
) {
  const viewportWidth = page.viewportSize()?.width ?? 0;
  await expect
    .poll(async () => {
      const box = await conversations.boundingBox();
      return box ? Math.round(box.x + box.width) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(viewportWidth - panelWidth);
  expect(await hasHorizontalOverflow(page)).toBe(false);
}

// The panel slides in, so a box read mid-animation puts the grab point beside
// the handle. Two equal reads a frame or more apart mean it has landed.
async function settledBox(locator: Locator) {
  let box = await locator.boundingBox();
  let previous = "";
  await expect
    .poll(
      async () => {
        box = await locator.boundingBox();
        const current = JSON.stringify(box);
        const settled = box !== null && current === previous;
        previous = current;
        return settled;
      },
      { intervals: [100] },
    )
    .toBe(true);
  if (!box) throw new Error("Resize handle has no box");
  return box;
}

function hasHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
}
