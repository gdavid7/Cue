import { expect, type Page } from "@playwright/test";
import { getEmailAccount } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { openMail, withClient } from "./mail-test-helpers";

// Both accounts read the same seeded mailbox, so this thread exists in each.
const THREAD_ID = "thr_playwright_reply";
const THREAD_SUBJECT = "Reply Workflow Message";
const SECOND_THREAD_SUBJECT = "Playwright Test Message";
const commandModifier = process.platform === "darwin" ? "Meta" : "Control";

test("chat works in the open thread's account and lists every account's chats", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const primary = await getEmailAccount(page);
  const second = await createSecondEmailAccount(emailAccountId);
  const chatIds = [
    `playwright-chat-${second.id}`,
    `playwright-chat-${primary.id}`,
  ];

  try {
    await seedChat(chatIds[0], second.id, "Second account planning");
    await seedChat(chatIds[1], primary.id, "Primary account planning");

    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    const conversations = page.getByRole("listbox", { name: "Conversations" });
    await expect(conversations).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Ask Cue", exact: true }).click();
    await expect(page.getByText(`Chat for ${primary.email}`)).toBeVisible({
      timeout: 60_000,
    });

    // Each seeded message is listed once per account, the page's first.
    const rows = conversations
      .getByRole("option")
      .filter({ hasText: SECOND_THREAD_SUBJECT });
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await rows.nth(1).click();
    // All Inboxes names the open thread's account by its position.
    await expect(page).toHaveURL(/[?&]account=1(&|$)/, { timeout: 60_000 });

    await expect(page.getByText(`Chat for ${second.email}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText(`Switched to ${second.email} for this conversation`),
    ).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "chat-follows-thread");

    await page.getByRole("button", { name: "Chat History" }).click();
    const secondChat = page.getByRole("menuitem", {
      name: /Second account planning/,
    });
    const primaryChat = page.getByRole("menuitem", {
      name: /Primary account planning/,
    });
    await expect(secondChat).toContainText(second.email);
    await expect(primaryChat).toContainText(primary.email);
    await capturePlaywrightCheckpoint(page, testInfo, "chat-history-accounts");

    await primaryChat.click();
    await expect(page.getByText(`Chat for ${primary.email}`)).toBeVisible();
    await expect(page.getByText("Plan for the primary account.")).toBeVisible({
      timeout: 60_000,
    });
    // The conversation is under way in the primary account, so the open
    // thread's account is offered rather than taken.
    await expect(
      page.getByText(`The open email is in ${second.email}`),
    ).toBeVisible();
  } finally {
    await deleteChats(chatIds);
    await deleteSecondEmailAccount(second.accountId);
  }
});

test("Command K archives the side-panel thread in that thread's account", async ({
  page,
}) => {
  const { emailAccountId } = await openMail(page);
  const second = await createSecondEmailAccount(emailAccountId);
  const operations: { url: string }[] = [];
  page.context().on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/operations/"))
      operations.push({ url: request.url() });
  });

  try {
    await page.goto(
      `/${emailAccountId}/mail?accountScope=all&side-panel-thread-id=${THREAD_ID}&side-panel-account-id=${second.id}`,
    );
    const sidePanel = page
      .getByRole("dialog")
      .filter({ hasText: THREAD_SUBJECT });
    await expect(sidePanel).toBeVisible({ timeout: 120_000 });

    await page.keyboard.press(`${commandModifier}+KeyK`);
    const archiveCommand = page
      .getByRole("option")
      .filter({ has: page.getByText("Archive", { exact: true }) });
    await expect(archiveCommand).toBeVisible();
    await archiveCommand.click();

    await expect(sidePanel).toBeHidden({ timeout: 60_000 });
    // The engine sends each account's operations to that account's address.
    await expect
      .poll(() => archivedThroughAccounts(operations), { timeout: 60_000 })
      .toEqual([second.id]);
  } finally {
    await unarchive(page, second.id);
    await unarchive(page, emailAccountId);
    await deleteSecondEmailAccount(second.accountId);
  }
});

// The archive is this test's only mailbox change, so every operation sent is it.
function archivedThroughAccounts(operations: { url: string }[]) {
  const accounts = operations.map(({ url }) =>
    decodeURIComponent(
      /\/api\/mail\/v1\/accounts\/([^/]+)\/operations\//.exec(url)?.[1] ?? "",
    ),
  );
  return [...new Set(accounts)];
}

async function unarchive(page: Page, emailAccountId: string) {
  await page.request
    .post(`/api/threads/${THREAD_ID}/unarchive`, {
      headers: { "X-Email-Account-ID": emailAccountId },
    })
    .catch(() => undefined);
}

async function seedChat(id: string, emailAccountId: string, name: string) {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Chat" (id, "emailAccountId", name, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, emailAccountId, name],
    );
    const text = name.startsWith("Primary")
      ? "Plan for the primary account."
      : "Plan for the second account.";
    await client.query(
      `INSERT INTO "ChatMessage" (id, "chatId", role, parts, "createdAt", "updatedAt")
       VALUES ($1, $2, 'user', $3::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`${id}-user`, id, JSON.stringify([{ type: "text", text }])],
    );
  });
}

async function deleteChats(ids: string[]) {
  await withClient((client) =>
    client.query(`DELETE FROM "Chat" WHERE id = ANY($1)`, [ids]),
  );
}
