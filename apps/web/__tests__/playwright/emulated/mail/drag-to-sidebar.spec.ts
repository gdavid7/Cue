import { expect, type Locator, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  insertInboxMailInConversation,
  openMail,
  readLatestMailMutation,
  readProviderAccessToken,
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

test("drags a conversation into an Outlook folder and Undo puts each message back", async ({
  page,
}, testInfo) => {
  test.skip(!isMicrosoftPlaywright(), "Only Outlook has folders");
  const run = `${testInfo.retry}-${Date.now()}`;
  const subject = `Folder drop ${run}`;
  const graph = await outlookGraph(page);
  const folder = await graph.createFolder(`Drop folder ${run}`);
  // One conversation in two places: the user's message in Sent and the
  // reply to it in the inbox.
  const sentId = await graph.createSentMessage(subject);
  const replyId = await insertInboxMailInConversation(page, {
    threadId: "",
    messageId: sentId,
    subject,
    from: "ada@example.com",
  });

  const { conversations } = await openMail(page);
  const row = conversationWithSubject(page, conversations, subject);
  await expect(row).toBeVisible({ timeout: 60_000 });
  const sidebar = page.getByRole("navigation", { name: "Mailboxes" });
  const target = sidebar.getByRole("link", {
    name: new RegExp(`^${folder.displayName}`),
  });
  await expect(target).toBeVisible();

  await dragOver(page, row, target);
  await expect(target).toHaveAttribute("data-drop", "target");
  await capturePlaywrightCheckpoint(page, testInfo, "drag-over-folder");
  await page.mouse.up();

  const moved = toast(page, `Moved to ${folder.displayName}`);
  await expect(moved).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect
    .poll(() => graph.folderOf(replyId), { timeout: 60_000 })
    .toBe(folder.id);
  await expect
    .poll(() => graph.folderOf(sentId), { timeout: 60_000 })
    .toBe(folder.id);

  await moved.getByRole("button", { name: /^Undo/ }).click();
  await expect(row).toBeVisible();
  await expect
    .poll(() => graph.folderOf(replyId), { timeout: 60_000 })
    .toBe("inbox");
  await expect
    .poll(() => graph.folderOf(sentId), { timeout: 60_000 })
    .toBe("sentitems");
  await capturePlaywrightCheckpoint(page, testInfo, "folder-move-undone");
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

/** The Outlook emulator's Graph API, as the provider sees the mailbox. */
async function outlookGraph(page: Page) {
  const baseUrl = process.env.MICROSOFT_BASE_URL;
  if (!baseUrl) throw new Error("MICROSOFT_BASE_URL is missing");
  const headers = {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
    "content-type": "application/json",
  };
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`${baseUrl}/v1.0/me${path}`, {
      headers,
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return {
    createFolder: (displayName: string) =>
      post("/mailFolders", { displayName }) as Promise<{
        id: string;
        displayName: string;
      }>,
    async createSentMessage(subject: string) {
      const draft = (await post("/messages", {
        subject,
        body: { contentType: "text", content: "Filed by a drag." },
        toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
      })) as { id: string };
      await post(`/messages/${draft.id}/move`, { destinationId: "sentitems" });
      return draft.id;
    },
    async folderOf(messageId: string) {
      const response = await page.request.get(
        `${baseUrl}/v1.0/me/messages/${messageId}`,
        { headers },
      );
      if (!response.ok()) return null;
      return ((await response.json()) as { parentFolderId?: string })
        .parentFolderId;
    },
  };
}
