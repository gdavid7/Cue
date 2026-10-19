import { expect, type Page } from "@playwright/test";
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
// No label: only Cue's note on it, which arrives after the thread opens, says
// it needs a reply, so the strip settles late.
const UNSORTED_SUBJECT = "Coffee next week?";
const UNSORTED_SUMMARY =
  "Priya wants to know if you're free for coffee on Tuesday.";
const SUMMARY =
  "Maya asks whether your graduation date is still June 2027 or you're going to grad school.";
const REPLY =
  "Hi Maya, my graduation date is still June 2027, and I'm not planning on grad school.";
const PREMIUM_ID = "playwright-cue-strip-premium";
const TO_REPLY_RULE_ID = "playwright-cue-strip-to-reply";
const DRAFT_ACTION_ID = "playwright-cue-strip-draft";
let restoreDrafting: (() => Promise<unknown>) | undefined;
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
const threads = {
  person: "",
  newsletter: "",
  unsorted: "",
  unsortedMessage: "",
};

test.beforeEach(async ({ page }) => {
  test.skip(
    isMicrosoftPlaywright(),
    "The strip is provider-neutral; Gmail labels make its categories easy to seed.",
  );
  const emailAccountId = await getEmailAccountId(page);
  await grantAiAccess(emailAccountId);
  // "Auto draft replies" off means Cue writes no reply, asked or not.
  restoreDrafting = await enableDraftReplies(emailAccountId);
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
  await registerLlmReply({
    match: `<email>\nSubject: ${UNSORTED_SUBJECT}\n`,
    object: { ...EMPTY_INSIGHT, action: "reply", task: "Say if Tuesday works" },
  });
  await registerLlmReply({
    match: `<subject>${UNSORTED_SUBJECT}</subject>`,
    object: { summary: UNSORTED_SUMMARY, keyPoints: [] },
  });
  // FYI, not To Reply: Draft a reply works for any email from a person, and
  // nothing drafts on its own before the user asks.
  const [fyi, newsletter] = await Promise.all([
    ensureLabel(page, "FYI"),
    ensureLabel(page, "Newsletter"),
  ]);
  ({ threadId: threads.person } = await ensureMessage(page, {
    from: "Maya Chen <maya@talent.example>",
    subject: PERSON_SUBJECT,
    body: PERSON_BODY,
    labelIds: ["INBOX", "UNREAD", fyi],
  }));
  ({ threadId: threads.newsletter } = await ensureMessage(page, {
    from: "Field Notes <hello@fieldnotes.example>",
    subject: NEWSLETTER_SUBJECT,
    body: "This week: three essays on slow travel. Read online or unsubscribe.",
    labelIds: ["INBOX", "UNREAD", newsletter],
  }));
  ({ threadId: threads.unsorted, messageId: threads.unsortedMessage } =
    await ensureMessage(page, {
      from: "Priya Shah <priya@studio.example>",
      subject: UNSORTED_SUBJECT,
      body: "Are you free for coffee on Tuesday afternoon? Priya",
      labelIds: ["INBOX", "UNREAD"],
    }));
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
  await restoreDrafting?.();
  restoreDrafting = undefined;
});

test("sums up a conversation with a person, not a newsletter, and drafts the reply", async ({
  page,
}, testInfo) => {
  const briefRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/user/thread-brief"))
      briefRequests.push(request.url());
  });
  const { conversations, emailAccountId } = await openMail(page);

  await conversationWithSubject(page, conversations, PERSON_SUBJECT).click();
  await expect(page.getByRole("heading", { name: PERSON_SUBJECT })).toBeVisible(
    { timeout: 60_000 },
  );
  const strip = page.getByRole("region", { name: "Cue summary" });
  await expect(strip.getByText(SUMMARY)).toBeVisible({ timeout: 60_000 });
  await expect(
    strip.getByRole("button", { name: "Ask Cue about this email" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-person");

  const briefModelCalls = await countBriefModelCalls();
  expect(briefModelCalls).toBeGreaterThan(0);
  const briefRequestsBeforeNewsletter = briefRequests.length;

  await openThread(
    page,
    emailAccountId,
    threads.newsletter,
    NEWSLETTER_SUBJECT,
  );
  await expectThreadReaderBody(page, "three essays on slow travel");
  await expect(strip).toHaveCount(0);
  expect(briefRequests).toHaveLength(briefRequestsBeforeNewsletter);
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-newsletter");

  await openThread(page, emailAccountId, threads.person, PERSON_SUBJECT);
  const editor = page.locator(
    '[data-testid="thread-reader"] [data-email-editor-content]',
  );
  await expect(strip.getByText(SUMMARY)).toBeVisible();
  // Reopening is answered from the cache the first open filled.
  expect(await countBriefModelCalls()).toBe(briefModelCalls);
  await expect(editor).toHaveCount(0);

  // Offered once, under the reply actions; the strip has no draft button.
  await expect(strip.getByRole("button", { name: /draft/i })).toHaveCount(0);
  await page
    .getByTestId("thread-reader")
    .getByRole("button", { name: "Draft a reply" })
    .click();
  await expect(editor).toContainText(REPLY, { timeout: 60_000 });
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-draft-reply");
});

// The strip's space is held from the first frame whenever it could show, so a
// summary that lands late never pushes the conversation down.
test("the conversation doesn't move when the strip settles", async ({
  page,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  // Cue's note on the email is what decides the strip here. The inbox works
  // it out ahead of time, as it would before the user opens the email, so
  // this checks the reader, not how fast the emulated provider answers under
  // load. The server keeps no notes (RD-3) and this browser does, so the
  // inbox is opened in this same browser and the note is waited for there.
  // Opening the email itself first would also start its suggested reply.
  await page.goto(`/${emailAccountId}/mail`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(
      () =>
        page.evaluate((messageId) => {
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (!key?.includes(":inbox-insight:")) continue;
            const kept = JSON.parse(window.localStorage.getItem(key) ?? "{}");
            const action = kept[messageId]?.value?.insight?.action;
            if (action) return action;
          }
          return null;
        }, threads.unsortedMessage),
      { timeout: 90_000 },
    )
    .toBe("reply");

  await page.addInitScript(() => {
    const tops: string[] = [];
    (window as unknown as { __messageTops: string[] }).__messageTops = tops;
    // Measured from the subject above it, so the page settling around the
    // reader (banners, the list loading) doesn't count; only what sits
    // between the subject and the first message, which is the strip.
    const sample = () => {
      const subject = document.querySelector("[data-mail-reader-subject]");
      const message = document.querySelector("[data-thread-message-id]");
      const strip = document.querySelector("[data-cue-strip-state]");
      if (subject && message) {
        const offset = Math.round(
          message.getBoundingClientRect().top -
            subject.getBoundingClientRect().top,
        );
        // The strip's state, height and busy flag ride along, to tell its
        // changes from the reader's; the subject's height explains a wrap.
        const busy =
          strip?.querySelector("[aria-busy]")?.getAttribute("aria-busy") ??
          "none";
        const entry = `${offset}:${strip?.getAttribute("data-cue-strip-state") ?? "none"}:${Math.round(strip?.getBoundingClientRect().height ?? 0)}:${busy}:${Math.round(subject.getBoundingClientRect().height)}`;
        if (tops.at(-1) !== entry) tops.push(entry);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await openThread(page, emailAccountId, threads.unsorted, UNSORTED_SUBJECT);
  const strip = page.getByRole("region", { name: "Cue summary" });
  await expect(strip.getByText(UNSORTED_SUMMARY)).toBeVisible({
    timeout: 60_000,
  });
  await expect(strip).toHaveAttribute("aria-busy", "false");

  const samples = await page.evaluate(
    () => (window as unknown as { __messageTops: string[] }).__messageTops,
  );
  // The strip is held from its first frame at the height it settles at, and
  // none of its own changes (deciding, showing, its summary landing) moves
  // the message: wherever the strip changes, the offset before is the offset
  // after. The reader's own first layout may move things on frames where the
  // strip is unchanged; that isn't the strip's doing. With Cue's note kept in
  // this browser, the strip shows from the first frame, so that first layout
  // now falls after it shows.
  const parsed = samples.map((sample) => {
    const [offset, state, height, busy] = sample.split(":");
    return { offset, state, height, busy };
  });
  const trail = samples.join(" → ");
  const firstShown = parsed.findIndex((sample) => sample.state === "show");
  expect(firstShown, trail).toBeGreaterThanOrEqual(0);
  const stripMoves = parsed.flatMap((sample, index) => {
    const before = parsed[index - 1];
    const stripChanged =
      before &&
      (before.state !== sample.state ||
        before.height !== sample.height ||
        before.busy !== sample.busy);
    return stripChanged && before.offset !== sample.offset
      ? [`${samples[index - 1]} → ${samples[index]}`]
      : [];
  });
  expect(stripMoves, trail).toEqual([]);
  const held = parsed.filter((sample) => sample.state !== "none");
  expect(new Set(held.map((sample) => sample.height)).size, trail).toBe(1);
  await capturePlaywrightCheckpoint(page, testInfo, "cue-strip-settled-late");

  // Ask Cue opens the assistant on this email with the cursor in it.
  await strip.getByRole("button", { name: "Ask Cue about this email" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Cue" }),
  ).toBeFocused();
});

test("the strip reads well in light and dark, on desktop and phones", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const emailAccountId = await getEmailAccountId(page);
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
      await openThread(page, emailAccountId, threads.person, PERSON_SUBJECT);
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

async function openThread(
  page: Page,
  emailAccountId: string,
  threadId: string,
  subject: string,
) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
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

// Drafting is the To Reply rule with a draft action. The database outlives
// this spec, so whatever was there is put back.
async function enableDraftReplies(emailAccountId: string) {
  return withClient(async (client) => {
    const existing = await client.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM "Rule"
       WHERE "emailAccountId" = $1 AND "systemType" = 'TO_REPLY'`,
      [emailAccountId],
    );
    const rule = existing.rows[0];
    if (!rule) {
      await client.query(
        `INSERT INTO "Rule"
          (id, name, enabled, automate, "runOnThreads", "systemType",
           "emailAccountId", "createdAt", "updatedAt")
         VALUES ($1, 'Cue strip To Reply', true, true, true, 'TO_REPLY', $2,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        [TO_REPLY_RULE_ID, emailAccountId],
      );
    } else {
      await client.query(`UPDATE "Rule" SET enabled = true WHERE id = $1`, [
        rule.id,
      ]);
    }
    const ruleId = rule?.id ?? TO_REPLY_RULE_ID;
    const drafts = await client.query(
      `SELECT 1 FROM "Action" WHERE "ruleId" = $1 AND type = 'DRAFT_EMAIL'`,
      [ruleId],
    );
    if (!drafts.rowCount) {
      await client.query(
        `INSERT INTO "Action"
          (id, type, "ruleId", "emailAccountId", "createdAt", "updatedAt")
         VALUES ($1, 'DRAFT_EMAIL', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`,
        [DRAFT_ACTION_ID, ruleId, emailAccountId],
      );
    }
    return () =>
      withClient(async (cleanup) => {
        await cleanup.query(`DELETE FROM "Action" WHERE id = $1`, [
          DRAFT_ACTION_ID,
        ]);
        if (rule) {
          await cleanup.query(`UPDATE "Rule" SET enabled = $2 WHERE id = $1`, [
            rule.id,
            rule.enabled,
          ]);
        } else {
          await cleanup.query(`DELETE FROM "Rule" WHERE id = $1`, [
            TO_REPLY_RULE_ID,
          ]);
        }
      });
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
// A retry runs beforeEach again against the same mailbox, so each is made once.
async function ensureMessage(
  page: Page,
  input: { from: string; subject: string; body: string; labelIds: string[] },
) {
  const headers = await gmailHeaders();
  const search = await page.request.get(
    `${gmailBaseUrl()}/gmail/v1/users/me/messages`,
    // Every inbox message, not a search: the emulator's search can't be
    // relied on to find these by subject.
    { headers, params: { labelIds: "INBOX", maxResults: "500" } },
  );
  expect(search.ok(), await search.text()).toBe(true);
  const found = (await search.json()) as {
    messages?: { id: string; threadId: string }[];
  };
  for (const candidate of found.messages ?? []) {
    const message = await page.request.get(
      `${gmailBaseUrl()}/gmail/v1/users/me/messages/${candidate.id}`,
      { headers, params: { format: "metadata" } },
    );
    const { payload } = (await message.json()) as {
      payload?: { headers?: { name: string; value: string }[] };
    };
    const subject = payload?.headers?.find(
      (header) => header.name.toLowerCase() === "subject",
    )?.value;
    if (subject === input.subject)
      return { threadId: candidate.threadId, messageId: candidate.id };
  }

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
  const message = (await inserted.json()) as { id: string; threadId: string };
  return { threadId: message.threadId, messageId: message.id };
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
