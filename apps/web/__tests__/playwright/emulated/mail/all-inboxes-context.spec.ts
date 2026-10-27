import { expect, type Page } from "@playwright/test";
import { getEmailAccount } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import { openMail, withClient } from "./mail-test-helpers";

// Each account has its own copy of the seeded mail, so this thread is in each.
const THREAD_ID = "thr_playwright_reply";
const THREAD_SUBJECT = "Reply Workflow Message";
const SECOND_THREAD_SUBJECT = "Playwright Test Message";
const commandModifier = process.platform === "darwin" ? "Meta" : "Control";

test("one chat covers every account and lists every account's chats", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const primary = await getEmailAccount(page);
  const second = await createSecondEmailAccount(emailAccountId);
  const chatIds: string[] = [
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
    await expect(
      page.getByRole("button", { name: "Chat History" }),
    ).toBeVisible({ timeout: 60_000 });
    // The chat covers every account, so it names none and offers no switch.
    await expect(page.getByText(/^Chat for /)).toHaveCount(0);

    // Each seeded message is listed once per account, the page's first.
    const rows = conversations
      .getByRole("option")
      .filter({ hasText: SECOND_THREAD_SUBJECT });
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await rows.nth(1).click();
    // All Inboxes names the open thread's account by its position.
    await expect(page).toHaveURL(/[?&]account=1(&|$)/, { timeout: 60_000 });

    // Opening another account's email leaves the chat as it is.
    await expect(page.getByText(/Switched to /)).toHaveCount(0);
    await expect(page.getByText(/The open email is in /)).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "chat-covers-accounts");

    // A message sent with the other account's email open names that email
    // with its account, and the chat answers it.
    const chatReply = `Cross-account reply ${Date.now()}`;
    await registerLlmReply({
      match: "this other account email",
      text: chatReply,
    });
    const chatInput = page.getByTestId("chat-input");
    await chatInput.fill("What is this other account email about?");
    const chatRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/chat",
    );
    const chatResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
      { timeout: 60_000 },
    );
    await chatInput.press("Enter");
    expect((await chatRequest).postDataJSON().openThreadId).toMatch(
      new RegExp(`^acct:${second.id}:`),
    );
    expect((await chatResponse).status()).toBe(200);
    await expect(page.getByText(chatReply)).toBeVisible({ timeout: 60_000 });
    chatIds.push((await chatRequest).postDataJSON().id);

    await page.getByRole("button", { name: "Chat History" }).click();
    const secondChat = page.getByRole("menuitem", {
      name: /Second account planning/,
    });
    const primaryChat = page.getByRole("menuitem", {
      name: /Primary account planning/,
    });
    await expect(secondChat).toBeVisible();
    await expect(primaryChat).toBeVisible();
    // One list, with no account line on each chat.
    await expect(secondChat).not.toContainText(second.email);
    await expect(primaryChat).not.toContainText(primary.email);
    await capturePlaywrightCheckpoint(page, testInfo, "chat-history-one-list");

    // A chat held by the second account opens from the primary's page.
    await secondChat.click();
    await expect(page.getByText("Plan for the second account.")).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole("button", { name: "Chat History" }).click();
    await page
      .getByRole("menuitem", { name: /Primary account planning/ })
      .click();
    await expect(page.getByText("Plan for the primary account.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/The open email is in /)).toHaveCount(0);
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

async function registerLlmReply(reply: { match: string; text: string }) {
  const response = await fetch(
    `${process.env.PLAYWRIGHT_LLM_BASE_URL}/__emulator/replies`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reply),
    },
  );
  expect(response.ok).toBe(true);
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
