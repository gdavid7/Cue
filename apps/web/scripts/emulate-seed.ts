import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DemoInboxAddress,
  DemoInboxFixture,
  DemoInboxMessage,
} from "../__tests__/fixtures/inboxes/types";
import type { CueDemoCalendarEvent } from "../__tests__/fixtures/inboxes/cue-demo-inbox";
import { saasFounderMixedInbox } from "../__tests__/fixtures/inboxes/demo-inboxes";

const DEFAULT_BASE_URL = "http://localhost:3000";
const GOOGLE_EMAIL = "developer@example.com";
const GOOGLE_NAME = "Developer";
const MICROSOFT_EMAIL = "developer@outlook.test";
const MICROSOFT_NAME = "Developer";
const TEAMMATE_GOOGLE_EMAIL = "teammate@example.com";
const TEAMMATE_MICROSOFT_EMAIL = "teammate@outlook.test";
const TEAMMATE_NAME = "Teammate";
// Gmail's inbox tabs besides Primary; Outlook files the same mail under Other.
const GMAIL_OTHER_TABS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

export type EmulateSeedOptions = {
  /** The inbox to seed. Defaults to the SaaS founder demo the tests expect. */
  fixture?: DemoInboxFixture;
  /** Address of the signed-in Google user. */
  googleEmail?: string;
  /** Display name of the signed-in Google user. */
  googleName?: string;
  calendarEvents?: CueDemoCalendarEvent[];
  /** Address of the Microsoft user. */
  microsoftEmail?: string;
  /** Display name of the Microsoft user. */
  microsoftName?: string;
  /** Outlook mail for the Microsoft user, on top of the emulator's samples. */
  microsoftFixture?: DemoInboxFixture;
  /** Events for the Microsoft user's default calendar. */
  microsoftCalendarEvents?: CueDemoCalendarEvent[];
  /** Fixed access tokens the emulator accepts, keyed by token. */
  tokens?: Record<string, { login: string; scopes: string[] }>;
};

export function buildEmulateSeed(
  baseUrl = DEFAULT_BASE_URL,
  {
    fixture = saasFounderMixedInbox,
    googleEmail = GOOGLE_EMAIL,
    googleName = GOOGLE_NAME,
    calendarEvents,
    microsoftEmail = MICROSOFT_EMAIL,
    microsoftName = MICROSOFT_NAME,
    microsoftFixture,
    microsoftCalendarEvents,
    tokens,
  }: EmulateSeedOptions = {},
) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");

  return {
    ...(tokens ? { tokens } : {}),
    google: {
      users: [{ email: googleEmail, name: googleName }],
      oauth_clients: [
        {
          client_id: "emulate-google-client.apps.googleusercontent.com",
          client_secret: "emulate-google-secret",
          redirect_uris: [
            `${normalizedBaseUrl}/api/auth/callback/google`,
            `${normalizedBaseUrl}/api/google/linking/callback`,
            `${normalizedBaseUrl}/api/google/calendar/callback`,
            `${normalizedBaseUrl}/api/google/drive/callback`,
          ],
        },
      ],
      labels: toSeedLabels(fixture, googleEmail),
      messages: toSeedMessages(fixture, {
        email: googleEmail,
        name: googleName,
      }),
      calendars: [
        {
          id: "primary",
          user_email: googleEmail,
          summary: googleEmail,
          primary: true,
          selected: true,
          time_zone: "UTC",
        },
      ],
      ...(calendarEvents ? { calendar_events: calendarEvents } : {}),
      drive_items: [
        {
          id: "drv_root_child",
          user_email: googleEmail,
          name: "Smoke Docs",
          mime_type: "application/vnd.google-apps.folder",
          parent_ids: ["root"],
        },
      ],
    },
    microsoft: {
      users: [{ email: microsoftEmail, name: microsoftName }],
      oauth_clients: [
        {
          client_id: "emulate-microsoft-client-id",
          client_secret: "emulate-microsoft-secret",
          redirect_uris: [
            `${normalizedBaseUrl}/api/auth/callback/microsoft`,
            `${normalizedBaseUrl}/api/outlook/linking/callback`,
            `${normalizedBaseUrl}/api/outlook/calendar/callback`,
            `${normalizedBaseUrl}/api/outlook/drive/callback`,
          ],
        },
      ],
      ...(microsoftFixture
        ? {
            categories: toSeedCategories(microsoftFixture, microsoftEmail),
            messages: toMicrosoftSeedMessages(microsoftFixture, {
              email: microsoftEmail,
              name: microsoftName,
            }),
          }
        : {}),
      ...(microsoftCalendarEvents
        ? {
            calendar_events: microsoftCalendarEvents.map(
              toMicrosoftCalendarEvent,
            ),
          }
        : {}),
    },
  };
}

export function buildEmulateSeedWithTeammates(baseUrl = DEFAULT_BASE_URL) {
  const seed = buildEmulateSeed(baseUrl);
  return {
    ...seed,
    google: {
      ...seed.google,
      users: [
        ...seed.google.users,
        { email: TEAMMATE_GOOGLE_EMAIL, name: TEAMMATE_NAME },
      ],
    },
    microsoft: {
      ...seed.microsoft,
      users: [
        ...seed.microsoft.users,
        { email: TEAMMATE_MICROSOFT_EMAIL, name: TEAMMATE_NAME },
      ],
    },
  };
}

export async function writeEmulateSeed(
  outputPath: string,
  baseUrl?: string,
  teammates = false,
  options?: EmulateSeedOptions,
) {
  if (teammates && options) {
    throw new Error("Seed options are not supported with teammates");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const seed = teammates
    ? buildEmulateSeedWithTeammates(baseUrl)
    : buildEmulateSeed(baseUrl, options);
  await writeFile(outputPath, `${JSON.stringify(seed, null, 2)}\n`);
}

function toSeedLabels(fixture: DemoInboxFixture, userEmail: string) {
  return fixture.labels.map((label) => ({
    id: label.id,
    user_email: userEmail,
    name: label.name,
    type: label.type,
  }));
}

function toSeedMessages(
  fixture: DemoInboxFixture,
  mailbox: { email: string; name: string },
) {
  const labelIdsByName = new Map(
    fixture.labels.map((label) => [label.name, label.id]),
  );

  return fixture.threads.flatMap((thread) =>
    thread.messages.map((message) => ({
      id: message.id,
      thread_id: thread.id,
      user_email: mailbox.email,
      from: formatAddress(
        rewriteMailboxAddress(fixture, message.from, mailbox),
      ),
      to: message.to
        .map((address) =>
          formatAddress(rewriteMailboxAddress(fixture, address, mailbox)),
        )
        .join(", "),
      cc: message.cc
        ?.map((address) =>
          formatAddress(rewriteMailboxAddress(fixture, address, mailbox)),
        )
        .join(", "),
      subject: message.subject,
      body_text: message.bodyText,
      body_html: message.bodyHtml,
      label_ids: getMessageLabelIds(message, labelIdsByName),
      internal_date: String(new Date(message.date).getTime()),
    })),
  );
}

// Outlook keeps the fixture's user labels as categories, matched by name.
function toSeedCategories(fixture: DemoInboxFixture, userEmail: string) {
  return fixture.labels
    .filter((label) => label.type === "user")
    .map((label, index) => ({
      id: categoryId(label.name),
      user_email: userEmail,
      display_name: label.name,
      // Outlook's 25 preset colors, so categories don't all share one.
      color: `preset${index % 25}`,
    }));
}

function toMicrosoftSeedMessages(
  fixture: DemoInboxFixture,
  mailbox: { email: string; name: string },
) {
  const categoryNames = new Set(
    fixture.labels
      .filter((label) => label.type === "user")
      .map((label) => label.name),
  );
  const toRecipient = (address: DemoInboxAddress) => {
    const { email, name } = rewriteMailboxAddress(fixture, address, mailbox);
    return { address: email, name };
  };

  return fixture.threads.flatMap((thread) =>
    thread.messages.map((message) => {
      const labels = message.labels ?? ["INBOX"];
      return {
        id: message.id,
        conversation_id: thread.id,
        user_email: mailbox.email,
        subject: message.subject,
        // A text body reaches the app's prompts exactly as Gmail's does.
        body_content: message.bodyHtml ?? message.bodyText,
        body_content_type: message.bodyHtml ? "html" : "text",
        from: toRecipient(message.from),
        to_recipients: message.to.map(toRecipient),
        cc_recipients: message.cc?.map(toRecipient),
        received_date_time: message.date,
        is_read: !message.unread,
        inference_classification: labels.some((label) =>
          GMAIL_OTHER_TABS.has(label),
        )
          ? "other"
          : "focused",
        categories: labels.filter((label) => categoryNames.has(label)),
        parent_folder_id: outlookFolderId(labels),
      };
    }),
  );
}

// The emulator gives well-known folders their well-known name as id.
function outlookFolderId(labels: string[]) {
  if (labels.includes("SENT")) return "sentitems";
  if (labels.includes("DRAFT")) return "drafts";
  if (labels.includes("INBOX")) return "inbox";
  return "archive";
}

// GUID-shaped like Graph's, and stable across emulator restarts so category
// ids the app stored stay valid.
function categoryId(name: string) {
  const hex = createHash("sha256").update(name).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function toMicrosoftCalendarEvent(event: CueDemoCalendarEvent) {
  return {
    id: event.id,
    user_email: event.user_email,
    calendar_id: event.calendar_id,
    subject: event.summary,
    body_preview: event.description,
    location_display_name: event.location,
    start_date_time: event.start_date_time,
    end_date_time: event.end_date_time,
    attendees: event.attendees.map((attendee) => ({
      address: attendee.email,
      name: attendee.display_name,
    })),
  };
}

function getMessageLabelIds(
  message: DemoInboxMessage,
  labelIdsByName: Map<string, string>,
) {
  const labelIds = new Set(
    (message.labels ?? ["INBOX"]).map(
      (label) => labelIdsByName.get(label) ?? label,
    ),
  );

  if (message.unread) labelIds.add("UNREAD");

  return [...labelIds];
}

function rewriteMailboxAddress(
  fixture: DemoInboxFixture,
  address: DemoInboxAddress,
  mailbox: { email: string; name: string },
): DemoInboxAddress {
  if (address.email !== fixture.mailbox.email) return address;

  return {
    email: mailbox.email,
    name: address.name ? mailbox.name : undefined,
  };
}

function formatAddress(address: DemoInboxAddress) {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}
