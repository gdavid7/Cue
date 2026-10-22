import { expect, type Locator, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  openMail,
  readLatestMailMutation,
} from "./mail-test-helpers";

test("drags a row onto a label, which the open Inbox refuses", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const row = conversationWithSubject(
    page,
    conversations,
    "Playwright Test Message",
  );
  const sidebar = page.getByRole("navigation", { name: "Mailboxes" });
  const inbox = sidebar.getByRole("link", { name: /^Inbox/ });
  const label = sidebar.getByRole("link", { name: /^Project Alpha/ });
  await expect(label).toBeVisible();

  // Driven by hand so the hover state of each row can be checked mid-drag.
  await dragOver(page, row, inbox);
  await expect(inbox).toHaveAttribute("data-drop", "blocked");
  await moveOver(page, label);
  await expect(label).toHaveAttribute("data-drop", "target");
  await expect(inbox).not.toHaveAttribute("data-drop");
  await capturePlaywrightCheckpoint(page, testInfo, "drag-over-label");
  await page.mouse.up();

  await expect(label).not.toHaveAttribute("data-drop");
  await expect(toast(page, "Label applied")).toBeVisible();
  await expect(row.getByText("Project Alpha", { exact: true })).toBeVisible();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_membership",
          threadId: "thr_playwright_1",
          payload: { membership: "label", id: "Label_project", present: true },
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
});

test("drags a selection onto Trash and brings it back with Undo", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  const first = conversationWithSubject(
    page,
    conversations,
    "Archive Action Message",
  );
  const second = conversationWithSubject(
    page,
    conversations,
    "Delete Action Message",
  );
  await first.getByRole("checkbox", { includeHidden: true }).click();
  await second.getByRole("checkbox", { includeHidden: true }).click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();

  const sidebar = page.getByRole("navigation", { name: "Mailboxes" });
  const trash = sidebar.getByRole("link", { name: /^Trash/ });
  if (!(await trash.isVisible())) {
    await sidebar.getByRole("button", { name: "More", exact: true }).click();
  }
  await dragOver(page, second, trash);
  await expect(trash).toHaveAttribute("data-drop", "target");
  await capturePlaywrightCheckpoint(page, testInfo, "drag-selection-to-trash");
  await page.mouse.up();

  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(toast(page, "Deleted 2 conversations")).toBeVisible();
  for (const threadId of TRASHED_THREADS) {
    await expectMutation(page, emailAccountId, "trash", threadId);
  }

  await toast(page, "Deleted 2 conversations")
    .getByRole("button", { name: /^Undo/ })
    .click();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  for (const threadId of TRASHED_THREADS) {
    await expectMutation(page, emailAccountId, "untrash", threadId);
  }
});

test("opens More while a drag rests on its toggle, and closes it after", async ({
  page,
}, testInfo) => {
  const { conversations } = await openMail(page);
  const row = conversationWithSubject(
    page,
    conversations,
    "Read Command Message",
  );
  const sidebar = page.getByRole("navigation", { name: "Mailboxes" });
  const more = sidebar.getByRole("button", { name: "More", exact: true });
  const trash = sidebar.getByRole("link", { name: /^Trash/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(trash).toHaveCount(0);

  // On the button inside the heading, not the heading's own padding.
  await dragOver(page, row, more);
  await expect(trash).toBeVisible();
  await moveOver(page, trash);
  await expect(trash).toHaveAttribute("data-drop", "target");
  await capturePlaywrightCheckpoint(page, testInfo, "drag-opens-more");

  // Let go over the list, which takes no drop.
  await moveOver(page, row);
  await page.mouse.up();
  await expect(trash).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("keeps clicking open and Shift+click selecting on draggable rows", async ({
  page,
}) => {
  const { conversations } = await openMail(page);
  const rows = conversations.getByRole("option");
  await expect(rows.nth(2)).toBeVisible();

  await rows.nth(0).getByRole("checkbox", { includeHidden: true }).click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  for (const index of [0, 1, 2]) {
    await expect(rows.nth(index)).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("Escape");
  await expect(page.getByText("3 selected", { exact: true })).toBeHidden();

  const row = conversationWithSubject(
    page,
    conversations,
    "Read Command Message",
  );
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Read Command Message" }),
  ).toBeVisible();
});

const TRASHED_THREADS = ["thr_playwright_archive", "thr_playwright_delete"];

/** Presses on the row and carries it, past the drag threshold, over `target`. */
async function dragOver(page: Page, row: Locator, target: Locator) {
  await row.hover();
  const box = await row.boundingBox();
  if (!box) throw new Error("The row has no box to drag from");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10, {
    steps: 4,
  });
  await moveOver(page, target);
}

async function moveOver(page: Page, target: Locator) {
  // The sidebar scrolls, and a row past its edge can't be hovered; a real
  // drag would scroll it by holding the pointer near that edge.
  await target.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const box = await target.boundingBox();
  if (!box) throw new Error("The drop target has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 8,
  });
}

function toast(page: Page, text: string) {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

async function expectMutation(
  page: Page,
  emailAccountId: string,
  kind: string,
  threadId: string,
) {
  await expect
    .poll(
      () => readLatestMailMutation(page, { emailAccountId, kind, threadId }),
      {
        timeout: 60_000,
      },
    )
    .toMatchObject({ status: "succeeded" });
}
