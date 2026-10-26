// Scenarios for Groundtruth's copy of Cue: `node .groundtruth/cue/scenario.mjs <name>`, run after reset.mjs.
// Every scenario first signs the fake mailbox (groundtruth-test@gmail.com) in once, headlessly, the way the CI
// browser suite's auth.setup.ts does, so the Cue account exists with onboarding done. The verifier's browser
// starts signed out and signs in with Google itself. Each scenario then adds its own data, through the
// emulators' APIs and Groundtruth's own database only.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ENV, PORTS } from "./env.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/web");
// Loaded from apps/web, which the app install provides; .groundtruth/node_modules may not be installed yet.
const requireWeb = createRequire(path.join(webDir, "package.json"));
const { Client } = requireWeb("pg");
const { chromium } = requireWeb("@playwright/test");
const EMAIL = APP_ENV.PLAYWRIGHT_TEST_EMAIL;
const APP = `http://localhost:${PORTS.app}`;
const GOOGLE = APP_ENV.GOOGLE_BASE_URL;
// The default the app's webhook route is started with (apps/web/playwright.config.mjs).
const PUBSUB_TOKEN = "playwright-token";
const WREN = "Wren Example <wren@example.com>";

const SCENARIOS = {
  "signed-in": async () => {},
  "muted-conversation-with-reply": seedMutedConversationWithReply,
  "team-workspace": seedTeamWorkspace,
  "sent-mail-bounced": async () => {
    await seedSentConversation("Quarterly plan", { from: "Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>", subject: "Undeliverable: Quarterly plan", body: "Your message wasn't delivered to kai@example.com." });
    await seedSentConversation("Lunch order", { from: "Kai Example <kai@example.com>", subject: "Re: Lunch order", body: "Two salads, please." });
  },
  // Google sign-in always connects the mailbox's calendar, so "no calendar" is the user's calendar switched
  // off on the Calendars page: none left to read.
  "invite-no-calendar": async () => {
    await expectCalendarConnected();
    await withClient((client) =>
      client.query(
        `UPDATE "Calendar" SET "isEnabled" = false WHERE "connectionId" IN (
           SELECT c.id FROM "CalendarConnection" c JOIN "EmailAccount" ea ON ea.id = c."emailAccountId" WHERE ea.email = $1)`,
        [EMAIL],
      ),
    );
  },
  "invite-one-conflict": async () => {
    await expectCalendarConnected();
    await wholeSecondMeeting();
  },
  "invite-two-conflicts": async () => {
    await expectCalendarConnected();
    const meeting = await wholeSecondMeeting();
    const start = new Date(new Date(meeting.start.dateTime).getTime() - 15 * 60_000);
    await google("POST", "/calendar/v3/calendars/primary/events", {
      summary: "Hiring sync",
      start: { dateTime: start.toISOString() },
      end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString() },
    });
  },
  "invite-free": async () => {
    await expectCalendarConnected();
    await google("DELETE", "/calendar/v3/calendars/primary/events/evt_playwright_meeting_bot");
  },
};

const name = process.argv[2];
const seed = SCENARIOS[name];
if (!seed) throw new Error(`Unknown scenario "${name}". Scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
const landedOn = await signIn();
await completeOnboarding(landedOn);
await seed();
console.log(`scenario ${name}: ready`);

async function signIn() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: APP });
    await page.goto("/login?next=%2Fwelcome-redirect", { waitUntil: "domcontentloaded" });
    const { url } = await page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/welcome-redirect", errorCallbackURL: "/login/error" }),
      });
      if (!response.ok) throw new Error(`OAuth sign-in failed with status ${response.status}`);
      return response.json();
    });
    await page.goto(url);
    await page.getByRole("button", { name: EMAIL }).click();
    await page.waitForURL((current) => current.href.startsWith(APP), { timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const landed = new URL(page.url());
    return `${landed.pathname}${landed.search}`;
  } finally {
    await browser.close();
  }
}

// As auth.setup.ts: onboarding done, and the first-run cards that would push the list down already dismissed.
async function completeOnboarding(landedOn) {
  await withClient(async (client) => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const user = await client.query(`UPDATE "User" SET "completedOnboardingAt" = CURRENT_TIMESTAMP WHERE email = $1`, [EMAIL]);
      const account = await client.query(
        `UPDATE "EmailAccount" SET "behaviorProfile" = '{}'::jsonb, "personaAnalysis" = '{}'::jsonb,
           "writingStyle" = 'Groundtruth seeded writing style' WHERE email = $1`,
        [EMAIL],
      );
      if (user.rowCount === 1 && account.rowCount === 1) {
        for (const prefix of ["inbox-style:", "cue-labels:", "today-intro:", "sample-thread:"]) {
          await client.query(
            `UPDATE "User" u SET "dismissedHints" = array_append(u."dismissedHints", $2::text || ea.id)
               FROM "EmailAccount" ea
               WHERE ea."userId" = u.id AND ea.email = $1 AND NOT ($2::text || ea.id = ANY(u."dismissedHints"))`,
            [EMAIL, prefix],
          );
        }
        for (const hintId of ["get-started:dismissed", "web-notifications-off"]) {
          await client.query(
            `UPDATE "User" SET "dismissedHints" = array_append("dismissedHints", $2)
               WHERE email = $1 AND NOT ($2 = ANY("dismissedHints"))`,
            [EMAIL, hintId],
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`The Cue account for ${EMAIL} wasn't created after sign-in (it landed on ${landedOn})`);
  });
}

// A conversation the user muted (archived, with its mute row), then a reply in it delivered the way Gmail
// push delivers new mail. Webhooks only run for premium accounts with AI and rules or filing, so the account
// gets both, as snooze-wake-on-reply.spec.ts does. The app's handling of the reply is what's under test, so
// this waits for it but never fails on it.
async function seedMutedConversationWithReply() {
  const emailAccountId = await accountId();
  await withClient(async (client) => {
    const premiumId = randomUUID();
    await client.query(
      `INSERT INTO "Premium" (id, "createdAt", "updatedAt", "pendingInvites", tier, "adminGrantTier", "adminGrantExpiresAt")
         VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ARRAY[]::text[], 'PLUS_MONTHLY', 'PLUS_MONTHLY', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [premiumId],
    );
    await client.query(`UPDATE "User" SET "premiumId" = $2 WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`, [emailAccountId, premiumId]);
    await client.query(
      `UPDATE "EmailAccount" SET "filingEnabled" = true, "filingPrompt" = 'Nothing to file',
         "watchEmailsSubscriptionId" = 'groundtruth-subscription' WHERE id = $1`,
      [emailAccountId],
    );
  });

  const subject = "Offsite venue shortlist";
  const original = await google("POST", "/gmail/v1/users/me/messages", {
    from: WREN,
    to: EMAIL,
    subject,
    body_text: "Three venues made the shortlist. Thoughts?",
    labelIds: ["INBOX"],
    internalDate: String(Date.now() - 60 * 60_000),
  });
  await withClient((client) =>
    client.query(`INSERT INTO "MutedThread" (id, "emailAccountId", "threadId") VALUES ($1, $2, $3)`, [randomUUID(), emailAccountId, original.threadId]),
  );
  await google("POST", `/gmail/v1/users/me/threads/${original.threadId}/modify`, { removeLabelIds: ["INBOX"] });

  const before = await google("GET", "/gmail/v1/users/me/profile");
  await withClient((client) =>
    client.query(`UPDATE "EmailAccount" SET "lastSyncedHistoryId" = $2 WHERE id = $1`, [emailAccountId, String(before.historyId)]),
  );
  const reply = await google("POST", "/gmail/v1/users/me/messages", {
    threadId: original.threadId,
    from: WREN,
    to: EMAIL,
    subject: `Re: ${subject}`,
    body_text: "Update: the lakeside venue is free in May.",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.now()),
  });
  const after = await google("GET", "/gmail/v1/users/me/profile");
  const data = Buffer.from(JSON.stringify({ emailAddress: EMAIL, historyId: after.historyId })).toString("base64");
  const response = await fetch(`${APP}/api/google/webhook?token=${PUBSUB_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { data } }),
  });
  if (!response.ok) throw new Error(`The webhook answered ${response.status}`);

  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const message = await google("GET", `/gmail/v1/users/me/messages/${reply.id}?format=minimal`);
    if (!(message.labelIds ?? []).includes("INBOX")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn("scenario: the reply is still in the inbox after 60 s");
}

// A conversation the user started with Kai, answered an hour later, as the CI suite's seedMailFromContact does:
// the answer comes from Kai or, for a bounce, from a mail server's own address.
async function seedSentConversation(subject, reply) {
  const sent = await google("POST", "/gmail/v1/users/me/messages", {
    from: EMAIL,
    to: "Kai Example <kai@example.com>",
    subject,
    body_text: "Can you look at this before Thursday?",
    labelIds: ["SENT"],
    internalDate: String(Date.now() - 2 * 60 * 60_000),
  });
  await google("POST", "/gmail/v1/users/me/messages", {
    threadId: sent.threadId,
    from: reply.from,
    to: EMAIL,
    subject: reply.subject,
    body_text: reply.body,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.now() - 60 * 60_000),
  });
}

// A team of two (the user and one teammate), so team comments are available.
async function seedTeamWorkspace() {
  const emailAccountId = await accountId();
  await withClient(async (client) => {
    const [userId, accountRecordId, teammateAccountId, organizationId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.query(
      `INSERT INTO "User" (id, email, name, "completedOnboardingAt", "createdAt", "updatedAt")
         VALUES ($1, 'sam.teammate@example.com', 'Sam Teammate', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId],
    );
    await client.query(
      `INSERT INTO "Account" (id, "userId", provider, "providerAccountId", type, "createdAt", "updatedAt")
         VALUES ($1, $2, 'google', $1, 'oauth', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [accountRecordId, userId],
    );
    await client.query(
      `INSERT INTO "EmailAccount" (id, email, name, "userId", "accountId", "createdAt", "updatedAt")
         VALUES ($1, 'sam.teammate@example.com', 'Sam Teammate', $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [teammateAccountId, userId, accountRecordId],
    );
    await client.query(
      `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt") VALUES ($1, 'Groundtruth team', $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO "Member" (id, "organizationId", "emailAccountId", role, "createdAt", "updatedAt")
         VALUES ($1, $3, $4, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), ($2, $3, $5, 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), randomUUID(), organizationId, emailAccountId, teammateAccountId],
    );
  });
}

// Sign-in connects the user's Google calendar itself (connect-sign-in-calendar.ts). Its seeded primary calendar
// holds "Product planning with notetaker", at the same time as the seeded "Project planning" invitation.
async function expectCalendarConnected() {
  await withClient(async (client) => {
    const result = await client.query(
      `SELECT k.id FROM "Calendar" k
         JOIN "CalendarConnection" c ON c.id = k."connectionId"
         JOIN "EmailAccount" ea ON ea.id = c."emailAccountId"
         WHERE ea.email = $1 AND c."isConnected" AND k."isEnabled" AND k."calendarId" = 'primary'`,
      [EMAIL],
    );
    if (result.rowCount !== 1) throw new Error("Sign-in didn't connect the fake Google calendar");
  });
}

// The seed times its meeting from Date.now(), milliseconds included, and the invitation's iCal times are whole
// seconds. A real calendar event never carries milliseconds (Google's API speaks whole seconds), so the meeting
// is recreated at the same time without them: otherwise the two disagree by a fraction of a second that no real
// mailbox can produce.
async function wholeSecondMeeting() {
  const seeded = await seededMeeting();
  const whole = (value) => {
    const date = new Date(value);
    date.setUTCMilliseconds(0);
    return date.toISOString();
  };
  await google("DELETE", `/calendar/v3/calendars/primary/events/${seeded.id}`);
  return google("POST", "/calendar/v3/calendars/primary/events", {
    summary: seeded.summary,
    start: { dateTime: whole(seeded.start.dateTime) },
    end: { dateTime: whole(seeded.end.dateTime) },
  });
}

async function seededMeeting() {
  // The emulator has no single-event read, so find it in the list.
  const { items = [] } = await google("GET", "/calendar/v3/calendars/primary/events");
  const meeting = items.find((event) => event.id === "evt_playwright_meeting_bot");
  if (!meeting) throw new Error("The seeded calendar meeting is missing");
  return meeting;
}

async function accountId() {
  return withClient(async (client) => {
    const result = await client.query(`SELECT id FROM "EmailAccount" WHERE email = $1`, [EMAIL]);
    if (!result.rows[0]) throw new Error("The Cue account is missing");
    return result.rows[0].id;
  });
}

async function google(method, route, body) {
  const token = await withClient(async (client) => {
    const result = await client.query(
      `SELECT account.access_token FROM "EmailAccount" ea JOIN "Account" account ON account.id = ea."accountId" WHERE ea.email = $1`,
      [EMAIL],
    );
    return result.rows[0]?.access_token;
  });
  if (!token) throw new Error("No Google token for the fake mailbox");
  const response = await fetch(`${GOOGLE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function withClient(callback) {
  const client = new Client({ connectionString: APP_ENV.DATABASE_URL });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}
