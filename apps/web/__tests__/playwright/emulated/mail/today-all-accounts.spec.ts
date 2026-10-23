import { expect, type Page, type Request } from "@playwright/test";
import { getEmailAccount } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  openMail,
  seedMailFromContact,
  toggleMailLayout,
  withClient,
} from "./mail-test-helpers";

// Each account has its own copy of the seeded mail. A Needs reply tracker in each
// account puts a different conversation in each account's lane.
const PRIMARY_THREAD = "thr_playwright_1";
const SECOND_THREAD = "thr_playwright_archive";
const TRACKER_PREFIX = "playwright-today-all-";

type Second = Awaited<ReturnType<typeof createSecondEmailAccount>>;

let second: Second | undefined;
let primaryId = "";

test.beforeEach(async ({ page }) => {
  const { emailAccountId } = await openMail(page);
  primaryId = emailAccountId;
  second = await createSecondEmailAccount(emailAccountId);
  await seedNeedsReply(primaryId, PRIMARY_THREAD);
  await seedNeedsReply(second.id, SECOND_THREAD);
});

test.afterEach(async ({ page }) => {
  await withClient((client) =>
    client.query(`DELETE FROM "ThreadTracker" WHERE "messageId" LIKE $1`, [
      `${TRACKER_PREFIX}%`,
    ]),
  );
  if (second) {
    await unarchive(page, second.id);
    await deleteSecondEmailAccount(second.accountId);
    second = undefined;
  }
});

test("Today from All inboxes shows every account, acts in each row's account, and comes back", async ({
  page,
}, testInfo) => {
  const account = second!;
  const primary = await getEmailAccount(page);
  const operations: string[] = [];
  page.context().on("request", (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/operations/"))
      operations.push(request.url());
  });

  await page.goto(`/${primaryId}/mail?accountScope=all`);
  await expect(
    page.getByRole("listbox", { name: "Conversations" }),
  ).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("navigation", { name: "Mailboxes" })
    .getByRole("link", { name: "Today", exact: true })
    .click();
  await expect(page).toHaveURL(/\/home\?accounts=all$/, { timeout: 60_000 });

  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
  const secondRow = todayRow(page, `${account.id}:${SECOND_THREAD}`);
  const primaryRow = todayRow(page, `${primaryId}:${PRIMARY_THREAD}`);
  await expect(
    secondRow.getByRole("img", { name: `Inbox: ${account.email}` }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    primaryRow.getByRole("img", { name: `Inbox: ${primary.email}` }),
  ).toBeVisible();
  // Account pages say which account they open while all accounts show.
  await expect(
    page
      .getByRole("navigation", { name: "App" })
      .getByRole("link", { name: /^Rules/ }),
  ).toContainText(primary.email);
  await capturePlaywrightCheckpoint(page, testInfo, "today-all-accounts");

  // Archive in the second account, then undo.
  const option = secondRow.getByRole("option");
  await option.hover();
  await secondRow
    .getByRole("button", { name: "Archive conversation" })
    .first()
    .click();
  await expect(option).toHaveCount(0);
  await expect
    .poll(() => operationAccounts(operations), { timeout: 60_000 })
    .toEqual([account.id]);
  await page
    .getByRole("region", { name: "Notifications alt+T" })
    .getByRole("button", { name: /^Undo/ })
    .click();
  await expect(option).toBeVisible({ timeout: 30_000 });

  // A row opens in All inboxes, in its own account, and comes back here.
  await option.click();
  await expect(page).toHaveURL(/\/all-inboxes\//, { timeout: 60_000 });
  await expect(page).toHaveURL(/[?&]account=1(&|$)/);
  await expect(page).toHaveURL(/[?&]from=today/);
  await page.getByRole("button", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL(/\/home\?accounts=all$/, { timeout: 60_000 });
  await expect(needsReply).toBeVisible({ timeout: 60_000 });
});

test("Today across accounts at phone width and in dark mode", async ({
  page,
}, testInfo) => {
  const account = second!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${primaryId}/home?accounts=all`);
  const secondRow = todayRow(page, `${account.id}:${SECOND_THREAD}`);
  await expect(
    secondRow.getByRole("img", { name: `Inbox: ${account.email}` }),
  ).toBeVisible({ timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "today-all-phone-light");

  await page.emulateMedia({ colorScheme: "dark" });
  await capturePlaywrightCheckpoint(page, testInfo, "today-all-phone-dark");

  await page.setViewportSize({ width: 1280, height: 900 });
  await capturePlaywrightCheckpoint(page, testInfo, "today-all-desktop-dark");
});

test("an account whose Today failed is named, and Today never says all clear", async ({
  page,
}, testInfo) => {
  const account = second!;
  await withClient((client) =>
    client.query(`DELETE FROM "ThreadTracker" WHERE "messageId" LIKE $1`, [
      `${TRACKER_PREFIX}%`,
    ]),
  );
  // Today's own answer only, not /api/user/home/deadlines, which loads apart.
  await page.route(
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      if (route.request().headers()["x-email-account-id"] !== account.id)
        return route.continue();
      await route.fulfill({ status: 500, json: { error: "Boom" } });
    },
  );

  await page.goto(`/${primaryId}/home?accounts=all`);
  await expect(
    page.getByText(`${account.email} couldn't be loaded`),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("All clear.")).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "today-all-failed");
});

test("a new mailbox shows Waiting on you across accounts before Today answers, and it stays put", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const account = second!;
  const primary = await getEmailAccount(page);
  const seeded = await seedMailFromContact(page, `Ski trip ${Date.now()}`);
  // The primary mailbox is new to Cue; the second is one Cue has read.
  await page.route(
    (url) => url.pathname === "/api/user/home/cue",
    (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids");
      return route.fulfill({
        json: {
          accounts: (ids ?? "")
            .split(",")
            .map((id) => ({ id, hasReadMail: id === account.id })),
        },
      });
    },
  );
  // Each account's own answer is held, as Gmail can take seconds to give it.
  const held = new Map<string, () => void>();
  const answers = new Map(
    [primaryId, account.id].map((id) => [
      id,
      new Promise<void>((resolve) => held.set(id, resolve)),
    ]),
  );
  const release = (id: string) => held.get(id)?.();
  await page.route(
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      const id = route.request().headers()["x-email-account-id"] ?? "";
      await answers.get(id);
      // Released as the test ends, the page may already be gone.
      const response = await route.fetch().catch(() => null);
      if (!response) return;
      const home = await response.json();
      if (id === primaryId) {
        home.cue = { aiAccess: true, replyTracking: true, hasReadMail: false };
        home.needsYou = [];
      }
      await route.fulfill({ response, json: home });
    },
  );
  const waitingOnYou = page.getByRole("listbox", {
    name: "Waiting on you",
    exact: true,
  });
  const row = waitingOnYou.locator(
    `[data-today-thread="${primaryId}:${seeded.threadId}"]`,
  );
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  try {
    await page.goto(`/${primaryId}/home?accounts=all`, {
      waitUntil: "domcontentloaded",
    });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expect(
      row.getByRole("img", { name: `Inbox: ${primary.email}` }),
    ).toBeVisible();
    // Only the new mailbox's: the one Cue has read waits for its answer.
    await expect(
      waitingOnYou.locator(`[data-today-thread^="${account.id}:"]`),
    ).toHaveCount(0);
    await expect(needsReply).toHaveCount(0);
    const option = row.getByRole("option").first();
    const before = await option.boundingBox();
    expect(before).not.toBeNull();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "today-all-waiting-on-you-before-answers",
    );

    // The new mailbox answers, then the one Cue has read, with its Needs
    // reply: the group stays where it showed, and Needs reply lands below.
    release(primaryId);
    await expect(
      page.getByRole("main").getByRole("status").first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(row).toBeVisible();
    expect((await option.boundingBox())?.y).toBeCloseTo(before?.y ?? -1, 0);

    release(account.id);
    await expect(
      needsReply.locator(
        `[data-today-thread="${account.id}:${SECOND_THREAD}"]`,
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(row).toBeVisible();
    expect((await option.boundingBox())?.y).toBeCloseTo(before?.y ?? -1, 0);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "today-all-waiting-on-you-after-answers",
    );
  } finally {
    for (const id of held.keys()) release(id);
    // Today refreshes while it loads; one may still be in the route.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await seeded.remove();
  }
});

test("mail another account may list in Needs reply waits for it, then shows once there, below Waiting on you", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const seeded = await seedMailFromContact(page, `Ski trip ${Date.now()}`);
  // Reads the primary's mailbox, so the seeded mail reached both accounts.
  const shared = await createSecondEmailAccount(primaryId, {
    mailbox: "primary",
  });
  await seedNeedsReply(shared.id, seeded.threadId);
  // The new account syncs in this browser first, from All inboxes, where
  // the mail shows once, naming the other account. Until then Waiting on
  // you waits too: which copies the account holds isn't known.
  await page.goto(`/${primaryId}/mail?accountScope=all`);
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  await expect(
    conversations
      .getByRole("option")
      .filter({ hasText: seeded.subject })
      .getByText(/^Also in /),
  ).toHaveCount(1, { timeout: 120_000 });
  // Only the primary mailbox is new to Cue.
  await page.route(
    (url) => url.pathname === "/api/user/home/cue",
    (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids");
      return route.fulfill({
        json: {
          accounts: (ids ?? "")
            .split(",")
            .map((id) => ({ id, hasReadMail: id !== primaryId })),
        },
      });
    },
  );
  // The account with the copy in Needs reply answers when let.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/user/home",
    async (route) => {
      const id = route.request().headers()["x-email-account-id"] ?? "";
      if (id === shared.id) await released;
      // Released as the test ends, the page may already be gone.
      const response = await route.fetch().catch(() => null);
      if (!response) return;
      const home = await response.json();
      if (id === primaryId) {
        home.cue = { aiAccess: true, replyTracking: true, hasReadMail: false };
        home.needsYou = [];
      }
      await route.fulfill({ response, json: home });
    },
  );
  const waitingOnYou = page.getByRole("listbox", {
    name: "Waiting on you",
    exact: true,
  });
  const needsReply = page.getByRole("listbox", { name: "Needs reply" });
  const copies = page.locator(`[data-today-thread$=":${seeded.threadId}"]`);
  try {
    await page.goto(`/${primaryId}/home?accounts=all`, {
      waitUntil: "domcontentloaded",
    });
    // Every message in the primary's inbox is in the shared account's too,
    // whose Needs reply may list it: until that answers, none shows here.
    await expect(
      page.getByRole("main").getByRole("status").first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(waitingOnYou).toHaveCount(0);
    // At most once: the primary's copy may show with the rest of its inbox.
    expect(await copies.count()).toBeLessThanOrEqual(1);
    await capturePlaywrightCheckpoint(page, testInfo, "today-all-copies-held");

    release();
    const listed = needsReply.locator(
      `[data-today-thread="${shared.id}:${seeded.threadId}"]`,
    );
    await expect(listed).toBeVisible({ timeout: 60_000 });
    // The rest join Waiting on you, above Needs reply; this one is in Needs
    // reply once and not in Waiting on you. (Outlook's emulator gives the
    // two accounts different newest messages here, so Also in your inbox
    // may still list the primary's copy: Today's merge, not this group.)
    await expect(waitingOnYou.getByRole("option").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      waitingOnYou.locator(`[data-today-thread$=":${seeded.threadId}"]`),
    ).toHaveCount(0);
    await expect(
      needsReply.locator(`[data-today-thread$=":${seeded.threadId}"]`),
    ).toHaveCount(1);
    const waitingOnYouBox = await waitingOnYou.boundingBox();
    const needsReplyBox = await needsReply.boundingBox();
    expect(needsReplyBox?.y ?? 0).toBeGreaterThan(waitingOnYouBox?.y ?? 0);
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "today-all-copy-in-needs-reply",
    );
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await seeded.remove();
    await deleteSecondEmailAccount(shared.accountId);
  }
});

test("All inboxes reads in the split layout, beside the list", async ({
  page,
}, testInfo) => {
  await page.goto(`/${primaryId}/mail?accountScope=all`);
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  await expect(conversations).toBeVisible({ timeout: 60_000 });
  const emptyReader = page.getByText("Nothing selected", { exact: true });

  await toggleMailLayout(page);
  try {
    await expect(emptyReader).toBeVisible();
    // Each seeded message is listed once per account; the second is account 1's.
    const rows = conversations
      .getByRole("option")
      .filter({ hasText: "Playwright Test Message" });
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await rows.nth(1).click();
    await expect(page).toHaveURL(/[?&]account=1(&|$)/, { timeout: 60_000 });
    await expect(
      page.getByRole("heading", { name: "Playwright Test Message" }),
    ).toBeVisible();
    await expect(conversations).toBeVisible();
    await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-split");
  } finally {
    // The layout is saved for the account, so put it back.
    await toggleMailLayout(page);
  }
});

test("All inboxes lists Snoozed and Scheduled for every account", async ({
  page,
}, testInfo) => {
  const account = second!;
  const asked = new Set<string>();
  page.context().on("request", (request: Request) => {
    if (request.url().includes("/api/user/snoozed-threads"))
      asked.add(request.headers()["x-email-account-id"] ?? "");
  });

  await page.goto(`/${primaryId}/mail?accountScope=all`);
  const mailboxes = page.getByRole("navigation", { name: "Mailboxes" });
  await mailboxes.getByRole("link", { name: "Snoozed", exact: true }).click();
  await expect(page).toHaveURL(/\/all-inboxes\/snoozed/, { timeout: 60_000 });
  await expect(
    page
      .getByRole("list", { name: "Snoozed conversations" })
      .or(page.getByText(/^Nothing snoozed\./)),
  ).toBeVisible({ timeout: 60_000 });
  // Each account is asked as itself.
  await expect
    .poll(() => [...asked].sort())
    .toEqual([primaryId, account.id].sort());

  await mailboxes.getByRole("link", { name: "Scheduled", exact: true }).click();
  await expect(page).toHaveURL(/\/all-inboxes\/scheduled/, {
    timeout: 60_000,
  });
  await expect(
    page
      .getByRole("list", { name: "Scheduled emails" })
      .or(page.getByText(/^Nothing scheduled\./)),
  ).toBeVisible({ timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "all-inboxes-scheduled");
});

function todayRow(page: Page, key: string) {
  return page.locator(`[data-today-thread="${key}"]`);
}

function operationAccounts(urls: string[]) {
  return [
    ...new Set(
      urls.map((url) =>
        decodeURIComponent(
          /\/api\/mail\/v1\/accounts\/([^/]+)\/operations\//.exec(url)?.[1] ??
            "",
        ),
      ),
    ),
  ];
}

async function seedNeedsReply(emailAccountId: string, threadId: string) {
  await withClient((client) =>
    client.query(
      `INSERT INTO "ThreadTracker" ("id", "updatedAt", "sentAt", "threadId", "messageId", "type", "emailAccountId")
       VALUES ($1, now(), now(), $2, $1, 'NEEDS_REPLY', $3)
       ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET "resolved" = false`,
      [
        `${TRACKER_PREFIX}${emailAccountId}-${threadId}`,
        threadId,
        emailAccountId,
      ],
    ),
  );
}

async function unarchive(page: Page, emailAccountId: string) {
  await page.request
    .post(`/api/threads/${SECOND_THREAD}/unarchive`, {
      headers: { "X-Email-Account-ID": emailAccountId },
    })
    .catch(() => undefined);
}
