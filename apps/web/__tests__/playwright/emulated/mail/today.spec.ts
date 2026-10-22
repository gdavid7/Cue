import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  openMail,
  readLatestMailMutation,
  readProviderAccessToken,
  waitForMetadataCoverage,
  withClient,
} from "./mail-test-helpers";

// Seeded inbox conversations, put in Today's "Needs reply" lane by a tracker.
const ARCHIVE_THREAD = "thr_playwright_archive";
const REPLY_THREAD = "thr_playwright_1";
const REPLY_SUBJECT = "Playwright Test Message";
const TRACKER_PREFIX = "playwright-today-";
const TODAY_SUBSCRIPTION_ID = "playwright-today-subscription";

test.beforeEach(async ({ page }) => {
  const emailAccountId = await getEmailAccountId(page);
  await seedNeedsReply(emailAccountId, [ARCHIVE_THREAD, REPLY_THREAD]);
});

test.afterEach(async () => {
  await withClient((client) =>
    client.query(`DELETE FROM "ThreadTracker" WHERE "messageId" LIKE $1`, [
      `${TRACKER_PREFIX}%`,
    ]),
  );
});

test("archives a conversation from Today and restores it with undo", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openToday(page);
  const row = todayRow(page, ARCHIVE_THREAD);
  const option = row.getByRole("option");
  await expect(option).toBeVisible();

  await option.hover();
  await capturePlaywrightCheckpoint(page, testInfo, "today-row-actions");
  await row.getByRole("button", { name: "Archive conversation" }).click();
  await expect(option).toHaveCount(0);
  // Focus moves on to the next row, so the keyboard keeps its place.
  await expect(page.locator('[role="option"]:focus')).toHaveCount(1);
  // The toast's Undo, while it shows, brings the row straight back.
  await page
    .getByRole("region", { name: "Notifications alt+T" })
    .getByRole("button", { name: /^Undo/ })
    .click();
  await expect(option).toBeVisible();

  // The inbox's keys work too: `e` archives the focused row, `z` undoes it.
  await option.focus();
  await page.keyboard.press("e");
  await expect(option).toHaveCount(0);
  await expectEngineMutation(page, emailAccountId, "archive");
  await page.keyboard.press("z");
  await expect(option).toBeVisible();
  await expectEngineMutation(page, emailAccountId, "unarchive");
});

test("bundles unread newsletters into one Reading row that opens in place and marks them all read", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const newsletter = await seedNewsletter(
    page,
    `Field Notes weekly ${Date.now()}`,
  );
  try {
    const { emailAccountId } = await openToday(page);
    const reading = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Reading/ }) });
    const bundle = reading.getByRole("button", { name: /^From .*Field Notes/ });
    await expect(bundle).toBeVisible({ timeout: 60_000 });
    await expect(bundle).toHaveAttribute("aria-expanded", "false");
    // One row for the bundle, not one per newsletter, and none elsewhere.
    await expect(todayRow(page, newsletter.threadId)).toHaveCount(0);
    await capturePlaywrightCheckpoint(page, testInfo, "today-reading-bundled");

    await bundle.click();
    await expect(bundle).toHaveAttribute("aria-expanded", "true");
    const list = page.getByRole("listbox", { name: "Reading" });
    await expect(
      list.locator(`[data-today-thread="${newsletter.threadId}"]`),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await reading.scrollIntoViewIfNeeded();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-reading-open-${theme}-${size.width}`,
        );
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Through the mail engine, as a row's own Mark as read goes.
    await reading.getByRole("button", { name: "Mark all read" }).click();
    await expect(reading).toHaveCount(0);
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "set_read_state",
            threadId: newsletter.threadId,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });
  } finally {
    await newsletter.remove();
  }
});

test("Mail bundles newsletters into one Reading row whose lane reads through them and archives them all with undo", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const subject = `Field Notes weekly ${Date.now()}`;
  const newsletter = await seedNewsletter(page, subject);
  try {
    const { conversations, emailAccountId } = await openMail(page);
    const bundle = page.getByRole("button", {
      name: /^Reading, from .*Field Notes/,
    });
    await expect(bundle).toBeVisible({ timeout: 60_000 });
    // One row for the bundle; the newsletter isn't a row of its own.
    const inboxRow = conversations.getByRole("option", { name: subject });
    await expect(inboxRow).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await expect(bundle).toBeVisible();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `mail-reading-bundle-${theme}-${size.width}`,
        );
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 800 });

    await bundle.click();
    await expect(page).toHaveURL(/\/type\/reading(\/|$|\?)/);
    const laneRow = page
      .getByRole("listbox", { name: "Conversations" })
      .getByRole("option", { name: subject });
    await expect(laneRow).toBeVisible({ timeout: 60_000 });
    await capturePlaywrightCheckpoint(page, testInfo, "mail-reading-lane");

    // Reading one marks it read, and it keeps its place in the lane.
    await laneRow.click();
    await expect(page.getByRole("heading", { name: subject })).toBeVisible({
      timeout: 60_000,
    });
    await page.keyboard.press("Escape");
    await expect(laneRow).toBeVisible();

    await page.getByRole("button", { name: "Archive all" }).click();
    await expect(laneRow).toHaveCount(0);
    await expect(page.getByText("Nothing left to read.")).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "mail-reading-empty");
    await expect
      .poll(
        () =>
          readLatestMailMutation(page, {
            emailAccountId,
            kind: "archive",
            threadId: newsletter.threadId,
          }),
        { timeout: 60_000 },
      )
      .toMatchObject({ status: "succeeded" });

    // Archive all keeps a row's undo, which brings the bundle back.
    await page
      .getByRole("region", { name: "Notifications alt+T" })
      .getByRole("button", { name: /^Undo/ })
      .click();
    await expect(laneRow).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Back to Inbox" }).click();
    await expect(bundle).toBeVisible({ timeout: 60_000 });
  } finally {
    await newsletter.remove();
  }
});

test("a first visit shows the inbox from local mail while Today loads", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  await waitForMetadataCoverage(page);
  // Today's answer is held, as Gmail can take seconds to give it.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/user/home*", async (route) => {
    await released;
    await route.continue();
  });

  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
  const inbox = page.getByRole("listbox", { name: "Also in your inbox" });
  await expect(inbox.getByRole("option").first()).toBeVisible({
    timeout: 60_000,
  });
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "today-local-inbox");

  release();
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
  // Each conversation shows once: what needs a reply leaves the rest.
  await expect(
    needsReply.locator(`[data-today-thread="${REPLY_THREAD}"]`),
  ).toHaveCount(1);
  await expect(
    inbox.locator(`[data-today-thread="${REPLY_THREAD}"]`),
  ).toHaveCount(0);
  await expect(
    inbox.locator(`[data-today-thread="${ARCHIVE_THREAD}"]`),
  ).toHaveCount(0);
  await expect(inbox.getByRole("option").first()).toBeVisible();
});

test("replies to a conversation from Today in the reader", async ({ page }) => {
  await openToday(page);
  const row = todayRow(page, REPLY_THREAD);
  await row.getByRole("option").hover();
  await row.getByRole("button", { name: "Reply to conversation" }).click();

  await expect(page).toHaveURL(/[?&]from=today/);
  await expect(
    page.getByRole("heading", { name: REPLY_SUBJECT }),
  ).toBeVisible();
  const editor = page.locator(
    '[data-testid="thread-reader"] [data-email-editor-content]',
  );
  await expect(editor).toBeFocused();
  await page.keyboard.type("Thanks, replying from Today.");
  await expect(editor).toContainText("Thanks, replying from Today.");
  // The reply starts once; the address no longer asks for one.
  await expect(page).not.toHaveURL(/[?&]reply=1/);

  // Leaving the conversation goes back to Today.
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL(/\/home(\?|$)/);
});

test("a reply sent from Outlook clears the conversation from Needs reply", async ({
  page,
}, testInfo) => {
  test.skip(
    !isMicrosoftPlaywright(),
    "Proves Outlook's sent-mail webhook; Gmail's history path has its own coverage.",
  );
  const { emailAccountId, needsReply } = await openToday(page);
  await expect(todayRow(page, REPLY_THREAD).getByRole("option")).toBeVisible();

  const account = await readOutlookAccount(emailAccountId);
  const cleanups: Array<() => Promise<unknown>> = [];
  try {
    cleanups.push(await enableReplyTracking(emailAccountId, account));
    await registerLlmReply({
      match: "determine the current status of this thread",
      object: {
        status: "AWAITING_REPLY",
        rationale: "The user replied and is waiting for an answer.",
      },
    });

    // Sent in Outlook itself, so only Graph's notification tells Cue.
    const comment = `Replied in Outlook ${Date.now()}`;
    const sentMessageId = await replyInOutlook(page, account.accessToken, {
      messageId: "msg_playwright_1",
      threadId: REPLY_THREAD,
      comment,
    });
    cleanups.push(() =>
      page.request.delete(
        `${process.env.MICROSOFT_BASE_URL}/v1.0/me/messages/${sentMessageId}`,
        { headers: { Authorization: `Bearer ${account.accessToken}` } },
      ),
    );
    const webhook = await page.request.post("/api/outlook/webhook", {
      data: {
        value: [
          {
            subscriptionId: TODAY_SUBSCRIPTION_ID,
            clientState:
              process.env.MICROSOFT_WEBHOOK_CLIENT_STATE ??
              "playwright-microsoft-webhook",
            changeType: "created",
            resourceData: { id: sentMessageId },
          },
        ],
      },
    });
    expect(webhook.ok(), await webhook.text()).toBe(true);

    await expect
      .poll(() => openNeedsReplyTrackers(emailAccountId, REPLY_THREAD), {
        timeout: 60_000,
      })
      .toBe(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(needsReply).toBeVisible({ timeout: 60_000 });
    // The reply moved it on to waiting for the other side's answer.
    await expect(
      needsReply.locator(`[data-today-thread="${REPLY_THREAD}"]`),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("listbox", { name: "Waiting on" })
        .locator(`[data-today-thread="${REPLY_THREAD}"]`),
    ).toHaveCount(1);
    await expect(
      needsReply.locator(`[data-today-thread="${ARCHIVE_THREAD}"]`),
    ).toHaveCount(1);
    await capturePlaywrightCheckpoint(page, testInfo, "today-outlook-replied");
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("Today's rows match the inbox in both themes and on phones", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    const { needsReply } = await openToday(page);
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await expect(needsReply.getByText(REPLY_SUBJECT)).toBeVisible();
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("Today says what needs you in one place: busy, all clear, and new", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  // The real answer, reshaped into each state, so counts and calendar stay real.
  let state: "busy" | "clear" | "new" = "busy";
  await page.route("**/api/user/home*", async (route) => {
    const response = await route.fetch();
    const home = await response.json();
    // Cue is checking (the emulated account has no AI plan); only "new" hasn't read mail yet.
    home.cue = {
      aiAccess: true,
      replyTracking: true,
      hasReadMail: state !== "new",
    };
    if (state !== "busy") home.needsYou = [];
    await route.fulfill({ response, json: home });
  });
  const main = page.getByRole("main");

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    for (const next of ["busy", "clear", "new"] as const) {
      state = next;
      const emailAccountId = await getEmailAccountId(page);
      await page.goto(`/${emailAccountId}/home`, {
        waitUntil: "domcontentloaded",
      });
      const status = main.getByRole("status");
      if (next === "busy") {
        await expect(status).toHaveText(/^\d+\+? needs? a reply/, {
          timeout: 60_000,
        });
        await expect(
          page.getByRole("listbox", { name: "Needs reply" }),
        ).toBeVisible();
      } else if (next === "clear") {
        await expect(status).toContainText("All clear.", { timeout: 60_000 });
        await expect(status).toContainText("Nothing needs a reply.");
        await expect(
          page.getByRole("listbox", { name: "Needs reply" }),
        ).toHaveCount(0);
      } else {
        await expect(status).toContainText("Cue is reading your recent mail.", {
          timeout: 60_000,
        });
        await expect(status).toContainText(
          "What needs a reply will appear here.",
        );
        await expect(page.getByText("All clear.")).toHaveCount(0);
      }
      // One line carries the state; empty lanes don't each say so.
      await expect(status).toHaveCount(1);
      await expect(page.getByText(/Nothing here|caught up/)).toHaveCount(0);
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(size.width);
        await capturePlaywrightCheckpoint(
          page,
          testInfo,
          `today-${next}-${theme}-${size.width}`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  }
});

test("Before your meeting stays inside a phone-width Today in both themes", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  // News comes from a search provider the emulated app has no key for.
  await page.route("**/api/user/meeting-news*", (route) =>
    route.fulfill({ json: { meetings: [LONG_MEETING_NEWS] } }),
  );
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await openToday(page);
    const card = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Before your meeting" }),
    });
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY),
      ).toBeLessThanOrEqual(size.width);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-meeting-news-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

const LONG_MEETING_NEWS = {
  eventId: "playwright-meeting-news",
  title: "Quarterly partnership review with the regional operations leadership",
  startTime: new Date(Date.now() + 86_400_000).toISOString(),
  organization: "Northwind Traders International Holdings",
  news: [
    {
      title:
        "Northwind Traders International Holdings announces a sweeping reorganization of its European logistics division",
      url: "https://news.example.com/northwind-reorganization",
      domain: "news.international-business-reporting-network.example.com",
      publishedDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
      title: "Northwind-Traders-International-Holdings-Q3-earnings-call-recap",
      url: "https://markets.example.com/northwind-q3",
      domain: "markets.example.com",
    },
  ],
};

async function openToday(page: Page) {
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
  return { emailAccountId, needsReply };
}

function todayRow(page: Page, threadId: string) {
  return page.locator(`[data-today-thread="${threadId}"]`);
}

async function seedNeedsReply(emailAccountId: string, threadIds: string[]) {
  await withClient(async (client) => {
    for (const threadId of threadIds) {
      await client.query(
        `INSERT INTO "ThreadTracker" ("id", "updatedAt", "sentAt", "threadId", "messageId", "type", "emailAccountId")
         VALUES ($1, now(), now(), $2, $1, 'NEEDS_REPLY', $3)
         ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET "resolved" = false`,
        [`${TRACKER_PREFIX}${threadId}`, threadId, emailAccountId],
      );
    }
  });
}

/**
 * An unread newsletter in the inbox, filed under the Newsletter label (an
 * Outlook category) as Cue's rule would, and what takes it out again.
 */
async function seedNewsletter(page: Page, subject: string) {
  const token = await readProviderAccessToken();
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const category = await page.request.post(
      `${base}/outlook/masterCategories`,
      { headers, data: { displayName: "Newsletter" } },
    );
    // Already there from an earlier run is as good.
    expect(category.ok() || category.status() === 409).toBe(true);
    const draft = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "Three essays on slow travel." },
        toRecipients: [{ emailAddress: { address: email } }],
      },
    });
    expect(draft.ok(), await draft.text()).toBe(true);
    const draftId = ((await draft.json()) as { id: string }).id;
    const patched = await page.request.patch(`${base}/messages/${draftId}`, {
      headers,
      data: {
        from: {
          emailAddress: {
            address: "hello@fieldnotes.example",
            name: "Field Notes",
          },
        },
        categories: ["Newsletter"],
        isRead: false,
      },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const moved = await page.request.post(`${base}/messages/${draftId}/move`, {
      headers,
      data: { destinationId: "inbox" },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const message = (await moved.json()) as {
      id: string;
      conversationId: string;
    };
    return {
      threadId: message.conversationId,
      remove: () =>
        page.request.post(`${base}/messages/${message.id}/permanentDelete`, {
          headers,
        }),
    };
  }

  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const labels = await page.request.get(`${base}/labels`, { headers });
  expect(labels.ok(), await labels.text()).toBe(true);
  const existing = (
    (await labels.json()) as { labels: { id: string; name: string }[] }
  ).labels.find((label) => label.name === "Newsletter");
  let labelId = existing?.id;
  if (!labelId) {
    const created = await page.request.post(`${base}/labels`, {
      headers,
      data: { name: "Newsletter" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    labelId = ((await created.json()) as { id: string }).id;
  }
  const inserted = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      from: "Field Notes <hello@fieldnotes.example>",
      to: email,
      subject,
      body_text: "Three essays on slow travel.",
      labelIds: ["INBOX", "UNREAD", labelId],
      internalDate: String(Date.now()),
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const message = (await inserted.json()) as { id: string; threadId: string };
  return {
    threadId: message.threadId,
    remove: () =>
      page.request.delete(`${base}/messages/${message.id}`, { headers }),
  };
}

async function expectEngineMutation(
  page: Page,
  emailAccountId: string,
  kind: string,
) {
  await expect
    .poll(
      () =>
        readLatestMailMutation(page, {
          emailAccountId,
          kind,
          threadId: ARCHIVE_THREAD,
        }),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "succeeded" });
}

type OutlookAccount = {
  accessToken: string;
  premiumId: string | null;
  watchEmailsSubscriptionId: string | null;
};

async function readOutlookAccount(
  emailAccountId: string,
): Promise<OutlookAccount> {
  return withClient(async (client) => {
    const result = await client.query<OutlookAccount>(
      `SELECT account.access_token AS "accessToken", app_user."premiumId",
         email."watchEmailsSubscriptionId"
       FROM "EmailAccount" email JOIN "Account" account ON account.id = email."accountId"
       JOIN "User" app_user ON app_user.id = email."userId"
       WHERE email.id = $1`,
      [emailAccountId],
    );
    if (!result.rows[0]?.accessToken)
      throw new Error("Missing emulator account");
    return result.rows[0];
  });
}

// Graph notifications are processed for premium accounts with a subscription
// and outbound replies only when a conversation status rule is on. Returns
// what puts the account back.
async function enableReplyTracking(
  emailAccountId: string,
  account: OutlookAccount,
) {
  const premiumId = `${TODAY_SUBSCRIPTION_ID}-premium`;
  const ruleId = `${TODAY_SUBSCRIPTION_ID}-awaiting`;
  const existingRule = await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Premium"
         (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[],
         'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [premiumId],
    );
    await client.query(
      `UPDATE "User" SET "premiumId" = $2
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId, premiumId],
    );
    await client.query(
      `UPDATE "EmailAccount" SET "watchEmailsSubscriptionId" = $2 WHERE id = $1`,
      [emailAccountId, TODAY_SUBSCRIPTION_ID],
    );
    const existing = await client.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'AWAITING_REPLY'`,
      [emailAccountId],
    );
    if (existing.rows[0]) {
      await client.query(`UPDATE "Rule" SET enabled = true WHERE id = $1`, [
        existing.rows[0].id,
      ]);
      return existing.rows[0];
    }
    await client.query(
      `INSERT INTO "Rule" (id, name, enabled, "systemType", "emailAccountId", "createdAt", "updatedAt")
       VALUES ($1, 'Playwright awaiting reply', true, 'AWAITING_REPLY', $2,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ruleId, emailAccountId],
    );
    return null;
  });

  return () =>
    withClient(async (client) => {
      await client.query(
        `DELETE FROM "ThreadTracker" WHERE "emailAccountId" = $1 AND "threadId" = $2
         AND "messageId" NOT LIKE $3`,
        [emailAccountId, REPLY_THREAD, `${TRACKER_PREFIX}%`],
      );
      if (existingRule)
        await client.query(`UPDATE "Rule" SET enabled = $2 WHERE id = $1`, [
          existingRule.id,
          existingRule.enabled,
        ]);
      else await client.query(`DELETE FROM "Rule" WHERE id = $1`, [ruleId]);
      await client.query(
        `UPDATE "EmailAccount" SET "watchEmailsSubscriptionId" = $2 WHERE id = $1`,
        [emailAccountId, account.watchEmailsSubscriptionId],
      );
      await client.query(
        `UPDATE "User" SET "premiumId" = $2
         WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
        [emailAccountId, account.premiumId],
      );
      await client.query(`DELETE FROM "Premium" WHERE id = $1`, [premiumId]);
    });
}

async function registerLlmReply(reply: { match: string; object: unknown }) {
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

// Replies through Graph, as Outlook would, and returns the sent message's id.
async function replyInOutlook(
  page: Page,
  accessToken: string,
  {
    messageId,
    threadId,
    comment,
  }: { messageId: string; threadId: string; comment: string },
) {
  const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const reply = await page.request.post(`${base}/messages/${messageId}/reply`, {
    headers,
    data: { comment },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
  const sent = await page.request.get(
    `${base}/mailFolders/sentitems/messages?$top=50`,
    { headers },
  );
  expect(sent.ok(), await sent.text()).toBe(true);
  const { value } = (await sent.json()) as {
    value: Array<{ id: string; conversationId: string; bodyPreview: string }>;
  };
  const message = value.find(
    (item) =>
      item.conversationId === threadId && item.bodyPreview.includes(comment),
  );
  if (!message) throw new Error("The Outlook reply is not in Sent Items");
  return message.id;
}

async function openNeedsReplyTrackers(
  emailAccountId: string,
  threadId: string,
) {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM "ThreadTracker" WHERE "emailAccountId" = $1 AND "threadId" = $2
       AND type = 'NEEDS_REPLY' AND resolved = false`,
      [emailAccountId, threadId],
    );
    return result.rowCount ?? 0;
  });
}
