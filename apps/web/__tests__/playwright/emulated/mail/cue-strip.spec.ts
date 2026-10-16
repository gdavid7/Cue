import { expect, type Locator, type Page } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  expectThreadReaderBody,
  openMail,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

const PERSON_SUBJECT = "Graduation date check-in";
const PERSON_BODY =
  "Hi! Before we finalize your offer, is your graduation date still June 2027, or are you planning to go to grad school instead? Thanks, Maya";
const NEWSLETTER_SUBJECT = "Field Notes Issue 43";
const SUMMARY =
  "Maya asks whether your graduation date is still June 2027 or you're going to grad school.";
const REPLY =
  "Hi Maya, my graduation date is still June 2027, and I'm not planning on grad school.";
const PREMIUM_ID = "playwright-cue-strip-premium";
// Every other email gets an empty note, as a real model would give most mail;
// otherwise the emulator's first enum value would say each one needs a reply.
const EMPTY_INSIGHT = {
  action: "none",
  task: "",
  date: "",
  dateRole: "none",
  fact: "",
  factLabel: "",
};

test.describe.configure({ mode: "serial" });

// The emulator lives for the whole spec, while each test starts a new device.
let seeded = false;

test.beforeEach(async ({ page }) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The strip is provider-neutral; Gmail labels make its categories easy to seed.",
  );
  const emailAccountId = await getEmailAccountId(page);
  await grantAiAccess(emailAccountId);
  await registerLlmReply({
    match: "You add a one-line note under an email",
    object: EMPTY_INSIGHT,
  });
  // The brief prompt lists each message with its escaped subject.
  await registerLlmReply({
    match: `<subject>${PERSON_SUBJECT}</subject>`,
    object: { summary: SUMMARY, keyPoints: [] },
  });
  await registerLlmReply({
    match: `<source id="m1" kind="message">\nSubject: ${PERSON_SUBJECT}`,
    object: {
      enoughEvidence: true,
      missing: "",
      webQuery: "",
      reply: REPLY,
      claims: [
        {
          fact: "Graduation is in June 2027",
          sourceId: "m1",
          quote: "graduation date still June 2027",
        },
      ],
    },
  });
  if (seeded) return;
  seeded = true;
  // FYI, not To Reply: Draft reply works for any email from a person, and
  // nothing drafts on its own before the user asks.
  const [fyi, newsletter] = await Promise.all([
    ensureLabel(page, "FYI"),
    ensureLabel(page, "Newsletter"),
  ]);
  await insertMessage(page, {
    from: "Maya Chen <maya@talent.example>",
    subject: PERSON_SUBJECT,
    body: PERSON_BODY,
    labelIds: ["INBOX", "UNREAD", fyi],
  });
  await insertMessage(page, {
    from: "Field Notes <hello@fieldnotes.example>",
    subject: NEWSLETTER_SUBJECT,
    body: "This week: three essays on slow travel. Read online or unsubscribe.",
    labelIds: ["INBOX", "UNREAD", newsletter],
  });
});

test.afterEach(async ({ page }) => {
  if (isMicrosoftPlaywright()) return;
  const emailAccountId = await getEmailAccountId(page);
  await withClient(async (client) => {
    await client.query(
      `UPDATE "User" SET "premiumId" = NULL
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)
         AND "premiumId" = $2`,
      [emailAccountId, PREMIUM_ID],
    );
    await client.query(`DELETE FROM "Premium" WHERE id = $1`, [PREMIUM_ID]);
  });
});

test("sums up a conversation with a person, not a newsletter, and drafts the reply", async ({
  page,
}, testInfo) => {
  const briefRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/user/thread-brief"))
      briefRequests.push(request.url());
  });
  const { conversations } = await openMail(page);

  await openConversation(page, conversations, PERSON_SUBJECT);
  const strip = page.getByRole("region", { name: "Cue summary" });
  await expect(strip.getByText(SUMMARY)).toBeVisible({ timeout: 60_000 });
  await expect(
    strip.getByRole("button", { name: "Ask Cue about this email" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-person");

  const briefModelCalls = await countBriefModelCalls();
  expect(briefModelCalls).toBeGreaterThan(0);
  const briefRequestsBeforeNewsletter = briefRequests.length;

  await openConversation(page, conversations, NEWSLETTER_SUBJECT);
  await expectThreadReaderBody(page, "three essays on slow travel");
  await expect(strip).toHaveCount(0);
  expect(briefRequests).toHaveLength(briefRequestsBeforeNewsletter);
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-newsletter");

  await openConversation(page, conversations, PERSON_SUBJECT);
  const editor = page.locator(
    '[data-testid="thread-reader"] [data-email-editor-content]',
  );
  await expect(strip.getByText(SUMMARY)).toBeVisible();
  // Reopening is answered from the cache the first open filled.
  expect(await countBriefModelCalls()).toBe(briefModelCalls);
  await expect(editor).toHaveCount(0);

  await strip.getByRole("button", { name: "Draft reply" }).click();
  await expect(editor).toContainText(REPLY, { timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-draft-reply");
});

test("the strip reads well in light and dark, on desktop and phones", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      const { conversations } = await openMail(page);
      await openConversation(page, conversations, PERSON_SUBJECT);
      const strip = page.getByRole("region", { name: "Cue summary" });
      await expect(strip.getByText(SUMMARY)).toBeVisible({ timeout: 60_000 });
      expect(await hasHorizontalOverflow(page)).toBe(false);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `cue-strip-${theme}-${size.width}`,
      );
    }
  }
});

async function openConversation(
  page: Page,
  conversations: Locator,
  subject: string,
) {
  await conversationWithSubject(page, conversations, subject).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
}

async function grantAiAccess(emailAccountId: string) {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Premium"
        (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
        VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[],
          'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')
        ON CONFLICT (id) DO NOTHING`,
      [PREMIUM_ID],
    );
    await client.query(
      `UPDATE "User" SET "premiumId" = $2
        WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId, PREMIUM_ID],
    );
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

async function countBriefModelCalls() {
  const response = await fetch(
    `${process.env.PLAYWRIGHT_LLM_BASE_URL}/__emulator/requests`,
  );
  const requests = (await response.json()) as {
    messages: { content: string }[];
  }[];
  return requests.filter((request) =>
    request.messages.some((message) =>
      message.content.includes(`<subject>${PERSON_SUBJECT}</subject>`),
    ),
  ).length;
}

async function ensureLabel(page: Page, name: string) {
  const base = `${gmailBaseUrl()}/gmail/v1/users/me/labels`;
  const headers = await gmailHeaders();
  const list = await page.request.get(base, { headers });
  expect(list.ok(), await list.text()).toBe(true);
  const { labels } = (await list.json()) as {
    labels: { id: string; name: string }[];
  };
  const existing = labels.find((label) => label.name === name);
  if (existing) return existing.id;
  const created = await page.request.post(base, { headers, data: { name } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

// New messages, so what Cue caches for them can't reach another spec's mail.
async function insertMessage(
  page: Page,
  input: { from: string; subject: string; body: string; labelIds: string[] },
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  const inserted = await page.request.post(
    `${gmailBaseUrl()}/gmail/v1/users/me/messages`,
    {
      headers: await gmailHeaders(),
      data: {
        from: input.from,
        to: email,
        subject: input.subject,
        body_text: input.body,
        labelIds: input.labelIds,
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
}

async function gmailHeaders() {
  return {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
    "content-type": "application/json",
  };
}

function gmailBaseUrl() {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  return baseUrl;
}

function hasHorizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
}
