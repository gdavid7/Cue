import { expect, type Locator, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { cleanupSeededChat, seedChat } from "../chat/chat-test-helpers";
import { conversationWithSubject, openMail } from "./mail-test-helpers";

const DEFAULT_WIDTH = 450;

test("drags the assistant panel wider, keeps the width after reload, and resets on double-click", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const { conversations } = await openMail(page);

  const handle = await openAssistantPanel(page);
  await expect(handle).toHaveAttribute("aria-valuenow", String(DEFAULT_WIDTH));

  const box = await handle.boundingBox();
  if (!box) throw new Error("Resize handle has no box");
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

test("closes the assistant with Escape from the mail list beside it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { conversations } = await openMail(page);
  // Registered before the panel's own listener, so it sees what mail did.
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      (window as { escapeClaimed?: boolean }).escapeClaimed =
        event.defaultPrevented;
    });
  });
  const row = conversations.getByRole("option").first();

  // With nothing selected, open or searched, mail's Escape has nothing to do
  // and leaves the key alone.
  await row.focus();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => (window as { escapeClaimed?: boolean }).escapeClaimed,
    ),
  ).toBe(false);

  await openAssistantPanel(page);
  const input = page.getByRole("textbox", { name: "Message Cue" });
  await expect(input).toBeVisible();
  await row.focus();
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.afterEach(async () => {
    await cleanupSeededChat();
  });

  test("covers the screen as a dialog: focus moves in, the mail leaves the tab order, and Escape closes inner menus first", async ({
    page,
  }, testInfo) => {
    const { emailAccountId } = await openMail(page);
    await seedChat(emailAccountId);
    const askCue = page.getByRole("button", { name: "Ask Cue" });

    // Enter on the button is its own activation, not mail's "open" shortcut.
    await askCue.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Chat" });
    await expect(panel).toBeFocused();
    await expect(
      panel.getByRole("textbox", { name: "Message Cue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("separator", { name: "Resize assistant panel" }),
    ).toBeHidden();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await capturePlaywrightCheckpoint(page, testInfo, "assistant-phone-open");

    // Every stop in a full lap of Tab stays in the panel; the mail behind it
    // is inert.
    const stops = new Set<string>();
    for (let press = 0; press < 20; press++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return "body";
        const inPanel = active.closest('[role="dialog"][aria-label="Chat"]');
        return inPanel
          ? `panel:${active.getAttribute("aria-label") ?? active.textContent?.trim()}`
          : `outside:${active.outerHTML.slice(0, 120)}`;
      });
      stops.add(stop);
    }
    expect([...stops].filter((stop) => stop.startsWith("outside:"))).toEqual(
      [],
    );
    expect(stops).toContain("panel:Message Cue");

    const history = panel.getByRole("button", { name: "Chat History" });
    await history.focus();
    await page.keyboard.press("Enter");
    const chatRow = page.getByRole("menuitem", { name: /Inbox planning/ });
    await expect(chatRow).toBeVisible();
    const menu = chatRow.locator("xpath=ancestor::*[@role='menu'][1]");

    // The history menu keeps Tab, so a row's options open with ArrowRight.
    await chatRow.focus();
    await page.keyboard.press("ArrowRight");
    const rename = page.getByRole("menuitem", { name: "Rename" });
    await expect(rename).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "assistant-phone-history-options",
    );

    // Each Escape closes only the innermost layer.
    await page.keyboard.press("Escape");
    await expect(rename).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(chatRow).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(history).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(askCue).toBeFocused();
    await capturePlaywrightCheckpoint(page, testInfo, "assistant-phone-closed");
  });

  test.describe("on a touchscreen", () => {
    test.use({ hasTouch: true });

    test("shows the chat-history options button without hover", async ({
      page,
    }, testInfo) => {
      const { emailAccountId } = await openMail(page);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      await seedChat(emailAccountId);

      await page.getByRole("button", { name: "Ask Cue" }).tap();
      const panel = page.getByRole("dialog", { name: "Chat" });
      await panel.getByRole("button", { name: "Chat History" }).tap();
      const options = page
        .getByRole("menuitem", { name: "Inbox planning" })
        .locator("..")
        .getByRole("button", { name: "Chat options" });
      await expect(options).toHaveCSS("opacity", "1");
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        "assistant-phone-history-options-touch",
      );

      await options.tap();
      await expect(
        page.getByRole("menuitem", { name: "Rename" }),
      ).toBeVisible();
    });

    test("shows a label chip's remove button without hover", async ({
      page,
    }, testInfo) => {
      const { conversations } = await openMail(page);
      await conversationWithSubject(
        page,
        conversations,
        "Project Label Message",
      ).tap();

      const removeLabel = page.getByRole("button", {
        name: "Remove Project Alpha label",
      });
      await expect(removeLabel).toHaveCSS("opacity", "1");
      await expect(removeLabel).toHaveCSS("pointer-events", "auto");
      // Proves a tap would land on it, without changing the shared mailbox.
      await removeLabel.tap({ trial: true });
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        "reader-phone-label-remove-touch",
      );
    });
  });
});

async function openAssistantPanel(page: Page) {
  await page.getByRole("button", { name: "Ask Cue" }).click();
  const handle = page.getByRole("separator", {
    name: "Resize assistant panel",
  });
  await expect(handle).toBeVisible();
  // The panel slides in; measuring the handle mid-slide puts the drag inside
  // the panel instead of on its edge.
  await expect(handle.locator("..")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
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

function hasHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
}
