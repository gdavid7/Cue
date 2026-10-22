import { expect, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { readProviderAccessToken, withClient } from "./mail-test-helpers";

const PLAYWRIGHT_TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL || "playwright-test@gmail.com";
// From utils/get-started/checklist.ts: the card shows when Get started does.
const DISMISSED_HINT = "get-started:dismissed";
const WEEKLY = {
  name: "Never Read Weekly",
  address: "never-read-weekly@example.com",
};
const DEALS = {
  name: "Never Read Deals",
  address: "never-read-deals@example.com",
};
const UNSUBSCRIBE_LINK = "https://unsubscribe.example/never-read-deals";
const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

type Saved = {
  userId: string;
  createdAt: Date;
  dismissedHints: string[];
  premiumId: string | null;
  emailAccountId: string;
};
let saved: Saved | undefined;
const removals: Array<() => Promise<void>> = [];

// As a person in their first week, with unsubscribe access, whose stats
// already hold one sender's unsubscribe link.
test.beforeEach(async ({ page }) => {
  const emailAccountId = await getEmailAccountId(page);
  const premiumId = premiumIdForRun();
  saved = await withClient(async (client) => {
    const result = await client.query<Omit<Saved, "emailAccountId">>(
      `SELECT u.id AS "userId", u."createdAt", u."dismissedHints", u."premiumId"
       FROM "User" u INNER JOIN "EmailAccount" ea ON ea."userId" = u.id
       WHERE ea.email = $1`,
      [PLAYWRIGHT_TEST_EMAIL],
    );
    const user = result.rows[0];
    if (!user) throw new Error("Could not find the Playwright account");
    await client.query(
      `INSERT INTO "Premium" (id, "createdAt", "updatedAt", "pendingInvites", tier)
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[], 'PRO_MONTHLY')
       ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier`,
      [premiumId],
    );
    await client.query(
      `UPDATE "User"
       SET "createdAt" = NOW() - INTERVAL '1 day',
           "dismissedHints" = array_remove("dismissedHints", $2),
           "premiumId" = $3
       WHERE id = $1`,
      [user.userId, DISMISSED_HINT, premiumId],
    );
    await client.query(
      `INSERT INTO "EmailMessage" (
         id, "createdAt", "updatedAt", "threadId", "messageId", date,
         "from", "fromName", "fromDomain", "to", "unsubscribeLink",
         read, sent, draft, inbox, "emailAccountId"
       )
       VALUES (
         'playwright_never_read_deals', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
         'playwright_never_read_deals', 'playwright_never_read_deals',
         CURRENT_TIMESTAMP - INTERVAL '1 day', $1, $2, 'example.com', $3, $4,
         false, false, false, true, $5
       )
       ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE
       SET "unsubscribeLink" = EXCLUDED."unsubscribeLink"`,
      [
        DEALS.address,
        DEALS.name,
        PLAYWRIGHT_TEST_EMAIL,
        UNSUBSCRIBE_LINK,
        emailAccountId,
      ],
    );
    return { ...user, emailAccountId };
  });
});

test.afterEach(async () => {
  for (const remove of removals.splice(0)) await remove().catch(() => {});
  const user = saved;
  saved = undefined;
  if (!user) return;
  await withClient(async (client) => {
    await client.query(
      `UPDATE "User"
       SET "createdAt" = $2, "dismissedHints" = $3, "premiumId" = $4
       WHERE id = $1`,
      [user.userId, user.createdAt, user.dismissedHints, user.premiumId],
    );
    await client.query(`DELETE FROM "Premium" WHERE id = $1`, [
      premiumIdForRun(),
    ]);
    await client.query(
      `DELETE FROM "EmailMessage"
       WHERE "emailAccountId" = $1 AND "messageId" = 'playwright_never_read_deals'`,
      [user.emailAccountId],
    );
    await client.query(
      `DELETE FROM "Newsletter" WHERE "emailAccountId" = $1 AND email = $2`,
      [user.emailAccountId, DEALS.address],
    );
  });
});

test("Mail you never read: frequent unread senders on Today, Not now kept, Unsubscribe through the existing flow", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  for (const sender of [WEEKLY, DEALS])
    for (let index = 0; index < 4; index++)
      removals.push(await seedUnreadInboxMail(page, sender, index));

  const card = page.getByRole("region", { name: "Mail you never read" });
  const weekly = card.locator(`[data-never-read-sender="${WEEKLY.address}"]`);
  const deals = card.locator(`[data-never-read-sender="${DEALS.address}"]`);
  const emailAccountId = await getEmailAccountId(page);

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await page.goto(`/${emailAccountId}/home`, {
      waitUntil: "domcontentloaded",
    });
    await expect(weekly).toBeVisible({ timeout: 120_000 });
    await expect(weekly).toContainText(WEEKLY.name);
    await expect(weekly).toContainText("4 emails, none opened");
    await expect(deals).toBeVisible();
    // Nothing on the card changes the user's mail settings.
    await expect(card.getByRole("button", { name: /skip inbox/i })).toHaveCount(
      0,
    );
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expect(weekly).toBeVisible();
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth).toBeLessThanOrEqual(size.width);
      await card.scrollIntoViewIfNeeded();
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-never-read-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize(SIZES[0]);
  }

  // Not now is kept in this browser across a reload.
  await weekly
    .getByRole("button", { name: `Not now for ${WEEKLY.name}` })
    .click();
  await expect(weekly).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  // The other sender shows, so the card has read local mail again.
  await expect(deals).toBeVisible({ timeout: 120_000 });
  await expect(weekly).toHaveCount(0);

  // Unsubscribe asks first, then calls the unsubscribe action Bulk
  // unsubscribe and the reader use, with the sender's stored link.
  await deals
    .getByRole("button", { name: `Unsubscribe from ${DEALS.name}` })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Unsubscribe from ${DEALS.name}?`, {
    timeout: 60_000,
  });
  await capturePlaywrightCheckpoint(page, testInfo, "today-never-read-confirm");
  const action = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      Boolean(request.headers()["next-action"]) &&
      (request.postData() ?? "").includes(DEALS.address),
  );
  await dialog.getByRole("button", { name: "Unsubscribe" }).click();
  const request = await action;
  const body = request.postData() ?? "";
  expect(body).toContain(emailAccountId);
  expect(body).toContain(UNSUBSCRIBE_LINK);
  expect((await request.response())?.ok()).toBe(true);
  // The emulated network can't reach the sender, so either outcome is the
  // existing flow's own answer.
  await expect(
    page
      .getByText(
        new RegExp(
          `^(Unsubscribed from|Couldn't unsubscribe from) ${DEALS.name}$`,
        ),
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
});

/**
 * One unread inbox message from `sender`, received in the last few hours.
 * Returns what takes it out again.
 */
async function seedUnreadInboxMail(
  page: Page,
  sender: { name: string; address: string },
  index: number,
) {
  const token = await readProviderAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const subject = `${sender.name} issue ${index + 1}`;
  if (isMicrosoftPlaywright()) {
    const base = `${process.env.MICROSOFT_BASE_URL}/v1.0/me`;
    const draft = await page.request.post(`${base}/messages`, {
      headers,
      data: {
        subject,
        body: { contentType: "text", content: "This week's picks." },
        toRecipients: [{ emailAddress: { address: PLAYWRIGHT_TEST_EMAIL } }],
      },
    });
    expect(draft.ok(), await draft.text()).toBe(true);
    const draftId = ((await draft.json()) as { id: string }).id;
    const patched = await page.request.patch(`${base}/messages/${draftId}`, {
      headers,
      data: { from: { emailAddress: sender }, isRead: false },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    const moved = await page.request.post(`${base}/messages/${draftId}/move`, {
      headers,
      data: { destinationId: "inbox" },
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const id = ((await moved.json()) as { id: string }).id;
    return async () => {
      await page.request.post(`${base}/messages/${id}/permanentDelete`, {
        headers,
      });
    };
  }

  const base = `${process.env.GOOGLE_BASE_URL}/gmail/v1/users/me`;
  const inserted = await page.request.post(`${base}/messages`, {
    headers,
    data: {
      from: `${sender.name} <${sender.address}>`,
      to: PLAYWRIGHT_TEST_EMAIL,
      subject,
      body_text: "This week's picks.",
      labelIds: ["INBOX", "UNREAD"],
      // Hours apart: a first sync may only cover the last day or two.
      internalDate: String(Date.now() - (index + 1) * 3_600_000),
    },
  });
  expect(inserted.ok(), await inserted.text()).toBe(true);
  const id = ((await inserted.json()) as { id: string }).id;
  return async () => {
    await page.request.delete(`${base}/messages/${id}`, { headers });
  };
}

function premiumIdForRun() {
  return `playwright_never_read_premium_${process.env.PLAYWRIGHT_RUN_ID ?? "local"}`;
}
