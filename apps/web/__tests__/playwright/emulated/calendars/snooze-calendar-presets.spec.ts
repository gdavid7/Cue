import { expect, type Page } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  conversationWithSubject,
  deleteProviderMessage,
  insertInboxThread,
  openMail,
  readProviderAccessToken,
  withClient,
} from "../mail/mail-test-helpers";
import {
  PLAYWRIGHT_TEST_EMAIL,
  resetCalendarTestState,
  setupCalendarTestState,
} from "./calendar-test-helpers";

const MINUTE = 60_000;

test.beforeEach(async () => {
  await setupCalendarTestState();
});

test.afterEach(async () => {
  await resetCalendarTestState();
});

test("snoozes a conversation until the next meeting the user hasn't declined ends", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const subject = `Snooze after meeting ${Date.now()}`;
  const token = await readProviderAccessToken();
  // Whole minutes, so the picker's time reads exactly as the event's end.
  const base = Math.ceil(Date.now() / MINUTE) * MINUTE;
  const declinedStart = new Date(base + 3 * MINUTE);
  const meetingStart = new Date(base + 5 * MINUTE);
  const meetingEnd = new Date(base + 35 * MINUTE);
  const eventIds: string[] = [];
  let messageId: string | undefined;
  let threadId: string | undefined;
  let emailAccountId: string | undefined;

  try {
    eventIds.push(
      await insertCalendarEvent(page, token, {
        summary: "Declined planning",
        start: declinedStart,
        end: new Date(base + 60 * MINUTE),
        responseStatus: "declined",
      }),
      await insertCalendarEvent(page, token, {
        summary: "Design review",
        start: meetingStart,
        end: meetingEnd,
        responseStatus: "accepted",
      }),
    );
    const inserted = await insertInboxThread(page, {
      subject,
      body: "Can we talk after your meeting?",
      from: { name: "Wren Example", address: "wren@example.com" },
    });
    messageId = inserted.messageId;
    threadId = inserted.threadId;

    const mail = await openMail(page);
    emailAccountId = mail.emailAccountId;
    const row = conversationWithSubject(page, mail.conversations, subject);
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await row.click();

    await page.getByRole("button", { name: "Snooze", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Snooze until" });
    const afterMeeting = picker.getByRole("button", {
      name: /^After my next meeting/,
    });
    await expect(afterMeeting).toBeVisible({ timeout: 60_000 });
    await expect(afterMeeting).toContainText(
      await formatInBrowser(page, meetingEnd),
    );
    await expect(
      picker.getByRole("button", { name: /^Tomorrow/ }),
    ).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "snooze-calendar-presets",
    );

    await afterMeeting.click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(
        () => readScheduledFor(emailAccountId as string, inserted.threadId),
        {
          timeout: 60_000,
        },
      )
      .toBe(meetingEnd.getTime());
  } finally {
    if (emailAccountId && threadId) {
      await withClient((client) =>
        client.query(
          `UPDATE "SnoozedThread" SET status = 'CANCELLED'
            WHERE "emailAccountId" = $1 AND "threadId" = $2
              AND status IN ('PREPARING', 'PENDING', 'EXECUTING')`,
          [emailAccountId, threadId],
        ),
      );
    }
    if (messageId) await deleteProviderMessage(page, token, messageId);
    for (const eventId of eventIds) {
      await page.request.delete(
        `${process.env.GOOGLE_BASE_URL}/calendar/v3/calendars/primary/events/${eventId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    }
  }
});

async function insertCalendarEvent(
  page: Page,
  token: string,
  input: {
    summary: string;
    start: Date;
    end: Date;
    responseStatus: "accepted" | "declined";
  },
) {
  const response = await page.request.post(
    `${process.env.GOOGLE_BASE_URL}/calendar/v3/calendars/primary/events`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        summary: input.summary,
        start: { dateTime: input.start.toISOString() },
        end: { dateTime: input.end.toISOString() },
        attendees: [
          {
            email: PLAYWRIGHT_TEST_EMAIL,
            responseStatus: input.responseStatus,
            self: true,
          },
          { email: "teammate@example.com", responseStatus: "accepted" },
        ],
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return String((await response.json()).id);
}

// The picker shows times in the browser's zone, as "Fri, Oct 23 at 3:30 PM".
function formatInBrowser(page: Page, date: Date) {
  return page.evaluate((ms) => {
    const value = new Date(ms);
    const day = value.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const time = value.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    // Chrome puts a narrow no-break space before AM/PM; date-fns doesn't.
    return `${day} at ${time.replace(/\u202f/g, " ")}`;
  }, date.getTime());
}

async function readScheduledFor(emailAccountId: string, threadId: string) {
  return withClient(async (client) => {
    // Prisma stores UTC without a zone; the epoch reads it as such.
    const result = await client.query<{ ms: string }>(
      `SELECT EXTRACT(EPOCH FROM "scheduledFor") * 1000 AS ms
        FROM "SnoozedThread"
        WHERE "emailAccountId" = $1 AND "threadId" = $2 AND status = 'PENDING'`,
      [emailAccountId, threadId],
    );
    const row = result.rows[0];
    return row ? Number(row.ms) : null;
  });
}
