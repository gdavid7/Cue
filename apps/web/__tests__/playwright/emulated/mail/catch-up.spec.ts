import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  inspectCommandIsActive,
  inspectCommandToMutation,
  type InspectCommand,
} from "@/utils/playwright/mail-inspect-command";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  activeSnoozeCount,
  openMail,
  openThreadIdFromUrl,
  providerConversationInInbox,
  readLatestMailMutation,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// Hint ids from utils/get-started/checklist.ts.
const DISMISSED_HINT = "get-started:dismissed";
const KEYBOARD_HINT = "get-started:keyboard";

type SavedUser = { id: string; createdAt: Date; dismissedHints: string[] };
type Touched = {
  messageId: string;
  threadId: string;
  action: "archive" | "keep" | "snooze";
  /** Another account's own mailbox token; the primary's when unset. */
  token?: string;
};

let saved: SavedUser | undefined;
// Conversations each test archived or read, put back as seeded afterwards.
let touched: Touched[] = [];

test.describe.configure({ mode: "serial" });

// As a person in their first week; setup closes the checklist, and with it
// Catch up, for every other spec.
test.beforeEach(async () => {
  touched = [];
  saved = await withClient(async (client) => {
    const result = await client.query<SavedUser>(
      `SELECT u.id, u."createdAt", u."dismissedHints"
       FROM "User" u INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL],
    );
    const user = result.rows[0];
    if (!user) throw new Error("Could not find the Playwright account");
    await client.query(
      `UPDATE "User"
       SET "createdAt" = NOW() - INTERVAL '1 day',
           "dismissedHints" = array_remove(array_remove("dismissedHints", $2), $3)
       WHERE id = $1`,
      [user.id, DISMISSED_HINT, KEYBOARD_HINT],
    );
    return user;
  });
});

test.afterEach(async () => {
  await restoreTouched(touched);
  touched = [];
  const user = saved;
  saved = undefined;
  if (!user) return;
  await withClient((client) =>
    client.query(
      `UPDATE "User" SET "createdAt" = $2, "dismissedHints" = $3 WHERE id = $1`,
      [user.id, user.createdAt, user.dismissedHints],
    ),
  );
});

test("works through the oldest unread mail from the keyboard, with undo", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { emailAccountId } = await openMail(page);

  let dialog = await openCatchUp(page);
  const first = await currentCard(dialog);
  const startLeft = await leftCount(dialog);
  expect(startLeft).toBeGreaterThan(2);
  expect(startLeft).toBeLessThanOrEqual(10);
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-card-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-card-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // E archives the card's conversation, and nothing in the list behind.
  await press(page, "e", first, "archive");
  await expect(dialog.getByText(`${startLeft - 1} left`)).toBeVisible();
  await expect
    .poll(() => archivedThreadIds(page), { timeout: 60_000 })
    .toEqual([first.threadId]);
  const second = await currentCard(dialog);
  expect(second.threadId).not.toBe(first.threadId);

  // S keeps it: marked read, and on to the next.
  await press(page, "s", second, "keep");
  await expect(dialog.getByText(`${startLeft - 2} left`)).toBeVisible();
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_read_state",
          threadId: second.threadId,
          payload: { read: true },
        }),
      { timeout: 60_000 },
    )
    .toBeDefined();
  expect((await currentCard(dialog)).threadId).not.toBe(second.threadId);

  // Undo puts the kept conversation back where it was, unread again.
  await expect(dialog.getByRole("button", { name: /Undo/ })).toBeVisible();
  await page.keyboard.press("z");
  await expect(dialog.getByText(`${startLeft - 1} left`)).toBeVisible();
  expect((await currentCard(dialog)).threadId).toBe(second.threadId);
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind: "set_read_state",
          threadId: second.threadId,
          payload: { read: false },
        }),
      { timeout: 60_000 },
    )
    .toBeDefined();
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-after-undo");

  // Focus never leaves the overlay, global keys stay off, and Escape closes it.
  for (let step = 0; step < 8; step++) await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // The list kept its own conversations: still only the card was archived.
  expect(await archivedThreadIds(page)).toEqual([first.threadId]);

  // R opens the card's conversation with a reply started.
  dialog = await openCatchUp(page);
  const replyTo = await currentCard(dialog);
  await page.keyboard.press("r");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => openThreadIdFromUrl(page.url()))
    .toBe(replyTo.threadId);
  await expect(
    page.locator('[data-testid="thread-reader"] [data-email-editor-content]'),
  ).toBeVisible({ timeout: 60_000 });
});

test("undoes a snooze: the card, the inbox and the server all go back", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { emailAccountId } = await openMail(page);
  const dialog = await openCatchUp(page);
  const card = await currentCard(dialog);
  const startLeft = await leftCount(dialog);

  touched.push({ ...card, action: "snooze" });
  await page.keyboard.press("h");
  const picker = page.getByRole("dialog", { name: "Snooze until" });
  await picker.getByRole("button", { name: /^Tomorrow/ }).click();
  await expect(dialog.getByText(`${startLeft - 1} left`)).toBeVisible();
  const undoLine = dialog.getByText(/^Snoozed “/);
  await expect(undoLine).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-snooze-undo");

  await dialog.getByRole("button", { name: /Undo/ }).click();
  await expect(dialog.getByText(`${startLeft} left`)).toBeVisible();
  expect((await currentCard(dialog)).threadId).toBe(card.threadId);
  await expect(undoLine).toBeHidden();
  await expect
    .poll(() => providerConversationInInbox(card.threadId), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(() => activeSnoozeCount(emailAccountId, card.threadId), {
      timeout: 60_000,
    })
    .toBe(0);
});

test("finishes a batch from Today on a phone and counts toward Get started", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, { waitUntil: "domcontentloaded" });

  const dialog = await openCatchUp(page);
  const total = await leftCount(dialog);
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-phone-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-phone-dark");
  await page.emulateMedia({ colorScheme: "light" });

  for (let left = total; left > 0; left--) {
    const card = await currentCard(dialog);
    const archive = left % 2 === 0;
    await press(page, archive ? "e" : "s", card, archive ? "archive" : "keep");
    if (left > 1)
      await expect
        .poll(async () => (await currentCard(dialog)).threadId)
        .not.toBe(card.threadId);
  }

  await expect(
    dialog.getByText(
      total === 1
        ? "You cleared 1 conversation."
        : `You cleared ${total} conversations.`,
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-finished-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "catch-up-finished-dark");
  await page.emulateMedia({ colorScheme: "light" });

  if (total >= 5) {
    await expect
      .poll(() => hasHint(KEYBOARD_HINT), { timeout: 30_000 })
      .toBe(true);
  }

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("works through the All inboxes Inbox tab and Today across accounts, acting and undoing in each card's own account", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { emailAccountId: primaryId } = await openMail(page);
  const second = await createSecondEmailAccount(primaryId);
  const tokens: Record<string, string | undefined> = {
    [second.id]: second.accessToken,
  };
  const operations: string[] = [];
  page.context().on("request", (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/operations/"))
      operations.push(request.url());
  });
  try {
    await page.goto(`/${primaryId}/mail?accountScope=all`);
    // Both accounts synced, so the batch draws on both.
    await expect(
      page
        .getByRole("listbox", { name: "Conversations" })
        .getByRole("option")
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^Loading mail from /)).toHaveCount(0, {
      timeout: 120_000,
    });

    const dialog = await openCatchUp(page);
    const total = await leftCount(dialog);
    const seen = new Set<string>();
    let previousAt = 0;
    // Archive the first card, then keep cards until both accounts have had
    // one: each change goes to the card's own account.
    for (let step = 0; step < total && seen.size < 2; step++) {
      const card = await currentCard(dialog);
      const account = await cardAccount(dialog);
      const at = await cardTime(dialog);
      // One order across accounts: oldest first.
      expect(at).toBeGreaterThanOrEqual(previousAt);
      previousAt = at;
      if (seen.size === 0 && step === 0)
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          "catch-up-all-inboxes-light",
        );
      const before = countFor(operations, account);
      await press(
        page,
        step === 0 ? "e" : "s",
        card,
        step === 0 ? "archive" : "keep",
        tokens[account],
      );
      await expect
        .poll(() => countFor(operations, account), { timeout: 60_000 })
        .toBeGreaterThan(before);
      seen.add(account);
      // The mailboxes share thread ids, so a card is its account and thread.
      if (step < total - 1)
        await expect
          .poll(
            async () =>
              `${await cardAccount(dialog)}:${(await currentCard(dialog)).threadId}`,
          )
          .not.toBe(`${account}:${card.threadId}`);
    }
    expect([...seen].sort()).toEqual([primaryId, second.id].sort());

    // Undo takes back the last card's change in that card's account.
    const last = [...seen].at(-1) ?? "";
    const otherAccount = [...seen].find((account) => account !== last) ?? "";
    const otherBefore = countFor(operations, otherAccount);
    const lastBefore = countFor(operations, last);
    await page.keyboard.press("z");
    await expect(dialog.getByText(/^Marked “/)).toBeHidden();
    await expect.poll(() => cardAccount(dialog)).toBe(last);
    await expect
      .poll(() => countFor(operations, last), { timeout: 60_000 })
      .toBeGreaterThan(lastBefore);
    expect(countFor(operations, otherAccount)).toBe(otherBefore);
    await page.emulateMedia({ colorScheme: "dark" });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "catch-up-all-inboxes-dark",
    );
    await page.emulateMedia({ colorScheme: "light" });

    // In All inboxes it's offered on the Inbox tab only, not a split tab.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-catch-up-entry]")).toBeVisible();
    const unreadTab = page.getByRole("button", { name: "Unread", exact: true });
    await unreadTab.click();
    await expect(unreadTab).toHaveAttribute("aria-current", "true");
    await expect(page.locator("[data-catch-up-entry]")).toHaveCount(0);

    // Today across accounts offers the same Catch up, each card acting in
    // its own account.
    await page.goto(`/${primaryId}/home?accounts=all`);
    await expect(page.locator("[data-today-thread]").first()).toBeVisible({
      timeout: 60_000,
    });
    const todayDialog = await openCatchUp(page);
    const todayCard = await currentCard(todayDialog);
    const todayAccount = await cardAccount(todayDialog);
    expect([primaryId, second.id]).toContain(todayAccount);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "catch-up-today-all-accounts-light",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "catch-up-today-all-accounts-dark",
    );
    await page.emulateMedia({ colorScheme: "light" });
    // Keep cards until one is a conversation Today lists, then archive it:
    // its row leaves Today, and Z in Catch up brings it back.
    const todayLeft = await leftCount(todayDialog);
    let listed:
      | { card: { messageId: string; threadId: string }; account: string }
      | undefined;
    for (let step = 0; step < todayLeft; step++) {
      const card = step === 0 ? todayCard : await currentCard(todayDialog);
      const account =
        step === 0 ? todayAccount : await cardAccount(todayDialog);
      if (await todayRow(page, account, card.threadId).count()) {
        listed = { card, account };
        break;
      }
      if (step === todayLeft - 1) break;
      await press(page, "s", card, "keep", tokens[account]);
      await expect
        .poll(
          async () =>
            `${await cardAccount(todayDialog)}:${(await currentCard(todayDialog)).threadId}`,
        )
        .not.toBe(`${account}:${card.threadId}`);
    }
    if (!listed)
      throw new Error("No Catch up card is a conversation Today lists");
    const row = todayRow(page, listed.account, listed.card.threadId);
    const todayBefore = countFor(operations, listed.account);
    await press(page, "e", listed.card, "archive", tokens[listed.account]);
    await expect
      .poll(() => countFor(operations, listed.account), { timeout: 60_000 })
      .toBeGreaterThan(todayBefore);
    await expect(row).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(todayDialog).toBeHidden();
  } finally {
    await restoreTouched(touched);
    touched = [];
    await deleteSecondEmailAccount(second.accountId);
  }
});

/** Today's row for a conversation, keyed across accounts by its account. */
function todayRow(page: Page, accountId: string, threadId: string) {
  return page.locator(`[data-today-thread="${accountId}:${threadId}"]`);
}

async function openCatchUp(page: Page) {
  const entry = page.locator("[data-catch-up-entry]");
  await expect(entry).toBeVisible({ timeout: 60_000 });
  await entry.getByRole("button", { name: "Catch up" }).click();
  const dialog = page.getByRole("dialog", { name: "Catch up" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-catch-up-card]")).toBeVisible({
    timeout: 60_000,
  });
  return dialog;
}

/** Presses a card key, noting the conversation for the cleanup. */
async function press(
  page: Page,
  key: string,
  card: { messageId: string; threadId: string },
  action: Touched["action"],
  token?: string,
) {
  touched.push({ ...card, action, token });
  await page.keyboard.press(key);
}

async function cardAccount(dialog: Locator) {
  const account = await dialog
    .locator("[data-catch-up-account]")
    .getAttribute("data-catch-up-account");
  if (!account) throw new Error("The Catch up card names no account");
  return account;
}

async function cardTime(dialog: Locator) {
  const value = await dialog
    .locator("[data-catch-up-card] time")
    .getAttribute("datetime");
  return value ? Date.parse(value) : 0;
}

/** Operations the server was sent for an account, by their URL. */
function countFor(urls: string[], accountId: string) {
  return urls.filter((url) =>
    url.includes(`/accounts/${encodeURIComponent(accountId)}/operations/`),
  ).length;
}

async function currentCard(dialog: Locator) {
  const card = dialog.locator("[data-catch-up-card]");
  const threadId = await card.getAttribute("data-catch-up-card");
  const messageId = await card.getAttribute("data-catch-up-message");
  if (!threadId || !messageId) throw new Error("No Catch up card is showing");
  return { threadId, messageId };
}

async function leftCount(dialog: Locator) {
  const text = await dialog.getByText(/^\d+ left$/).textContent();
  return Number(text?.match(/\d+/)?.[0]);
}

/** Every conversation the mail engine has an archive queued or sent for. */
async function archivedThreadIds(page: Page) {
  const commands = await page.evaluate(async () => {
    const inspect = window.__inboxZeroMailInspect;
    if (!inspect?.read) return [];
    const diagnostics = (await inspect.read()) as {
      commands?: InspectCommand[];
    };
    return diagnostics.commands ?? [];
  });
  return [
    ...new Set(
      commands
        .filter(inspectCommandIsActive)
        .map(inspectCommandToMutation)
        .filter((mutation) => mutation.kind === "archive")
        .map((mutation) => mutation.threadId),
    ),
  ];
}

async function hasHint(hintId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ has: boolean }>(
      `SELECT $2 = ANY(u."dismissedHints") AS has
       FROM "User" u INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL, hintId],
    );
    return result.rows[0]?.has ?? false;
  });
}

// Back in the inbox and unread, as seeded, for a retry or a later spec.
async function restoreTouched(entries: Touched[]) {
  if (!entries.length) return;
  // Each mailbox is put back with its own token.
  const others = entries.filter((entry) => entry.token);
  for (const token of new Set(others.map((entry) => entry.token))) {
    await restoreMailbox(
      others.filter((entry) => entry.token === token),
      token,
    );
  }
  await restoreMailbox(entries.filter((entry) => !entry.token));
}

async function restoreMailbox(entries: Touched[], token?: string) {
  if (!entries.length) return;
  const snoozed = entries.filter((entry) => entry.action === "snooze");
  if (snoozed.length) {
    await withClient((client) =>
      client.query(
        `UPDATE "SnoozedThread" SET status = 'CANCELLED'
         WHERE "threadId" = ANY($1)
           AND status IN ('PREPARING', 'PENDING', 'EXECUTING')`,
        [snoozed.map((entry) => entry.threadId)],
      ),
    );
  }
  if (isMicrosoftPlaywright()) {
    const headers = {
      Authorization: `Bearer ${token ?? "playwright_microsoft_fixture_token"}`,
      "content-type": "application/json",
    };
    for (const { messageId, action } of entries) {
      let id = messageId;
      if (action !== "keep") {
        const moved = await fetch(
          `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${id}/move`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ destinationId: "inbox" }),
          },
        );
        if (moved.ok) id = ((await moved.json()) as { id: string }).id;
      }
      const read = await fetch(
        `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${id}`,
        { method: "PATCH", headers, body: JSON.stringify({ isRead: false }) },
      );
      expect(read.ok).toBe(true);
    }
    return;
  }
  const response = await fetch(
    `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/batchModify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token ?? (await readProviderAccessToken())}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ids: entries.map((entry) => entry.messageId),
        addLabelIds: ["INBOX", "UNREAD"],
      }),
    },
  );
  expect(response.ok).toBe(true);
}
