// Demo data for one everyday person, Alex Rivera: a parent with a personal Gmail,
// an old Outlook address that still gets mail, a Google Calendar, and a Drive.
//
// Each object is written in (a trimmed version of) its provider's *raw* format, so
// the normalizer in normalize.ts does the same translation work it would do on
// real API responses.

export const DEMO_NOW = "2026-10-13T16:00:00Z"; // Tue Oct 13, 9:00am Pacific

export const demoUser = {
  name: "Alex Rivera",
  accounts: [
    { id: "acct_gmail", provider: "gmail", address: "alex.rivera@gmail.com", label: "Personal (Gmail)" },
    { id: "acct_outlook", provider: "outlook", address: "alex.rivera@outlook.com", label: "Old inbox (Outlook)" },
    { id: "acct_gcal", provider: "gcal", address: "alex.rivera@gmail.com", label: "Google Calendar" },
    { id: "acct_gdrive", provider: "gdrive", address: "alex.rivera@gmail.com", label: "Google Drive" },
    // Connected through the generic path — no Slack- or Notion-specific code in Cue.
    { id: "acct_slack", provider: "slack", address: "alex.rivera@gmail.com", label: "Slack · Hornets Parents" },
    { id: "acct_notion", provider: "notion", address: "alex.rivera@gmail.com", label: "Notion" },
  ],
  /** People the user has labelled as family get a priority boost (and a warmer sign-off). */
  family: [{ email: "linda.rivera52@yahoo.com", label: "Mom" }],
} as const;

// Gmail API: users.messages.get (format=full), heavily trimmed.
export interface GmailRaw {
  id: string;
  threadId: string;
  internalDate: string; // ms since epoch, as a string — like the real API
  payload: { headers: { name: string; value: string }[]; body: { data: string } };
  attachments?: string[];
}

// Microsoft Graph: /me/messages
export interface OutlookRaw {
  id: string;
  conversationId: string;
  subject: string;
  receivedDateTime: string;
  from: { emailAddress: { name: string; address: string } };
  toRecipients: { emailAddress: { name: string; address: string } }[];
  body: { contentType: "text"; content: string };
}

// Google Calendar API: events.list
export interface GcalRaw {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  attendees?: { email: string; displayName?: string; self?: boolean }[];
}

// Google Drive API: files.list + exported text
export interface GdriveRaw {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  owners: { displayName: string; emailAddress: string }[];
  permissions?: { emailAddress: string; displayName?: string }[];
  exportedText: string;
}

const ALEX = "Alex Rivera <alex.rivera@gmail.com>";
const ms = (iso: string) => String(Date.parse(iso));
const gmail = (
  id: string,
  threadId: string,
  date: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  attachments?: string[],
): GmailRaw => ({
  id,
  threadId,
  internalDate: ms(date),
  payload: {
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      { name: "Subject", value: subject },
    ],
    body: { data: Buffer.from(body).toString("base64url") },
  },
  attachments,
});

export const gmailMessages: GmailRaw[] = [
  // Kid's soccer: a request with two asks and a hidden calendar conflict.
  gmail(
    "g1", "gt_soccer", "2026-09-02T17:00:00Z",
    "Dana Kim <dana.kim@eastsideyouthsoccer.org>", ALEX,
    "Welcome to the Hornets fall season!",
    "Welcome to the Eastside Hornets fall season! Games are on Saturdays and practice is Tue/Thu at 5pm at Garfield Park. " +
      "Every player needs a signed medical release form on file before Oct 17. — Coach Dana",
  ),
  gmail(
    "g2", "gt_soccer", "2026-10-12T18:20:00Z",
    "Dana Kim <dana.kim@eastsideyouthsoccer.org>", ALEX,
    "Re: Welcome to the Hornets fall season!",
    "Hi Alex, the rained-out game is rescheduled to this Saturday, Oct 17 at 9:00am at Garfield Park. Can Maya make it? " +
      "Also, I still don't have her signed medical release form. Could you send it over before Saturday? Thanks! Coach Dana",
  ),

  // Landlord: a real decision with a deadline, and a fact buried in an old PDF.
  gmail(
    "g3", "gt_lease", "2026-08-15T16:00:00Z",
    "Priya Shah <priya@maplecourtapts.com>", ALEX,
    "Lease renewals this fall",
    "Hi residents, renewal notices go out in October. As a reminder, renewal increases are capped by your lease. — Priya, Maple Court Apartments",
  ),
  gmail(
    "g4", "gt_lease", "2026-10-10T17:30:00Z",
    "Priya Shah <priya@maplecourtapts.com>", ALEX,
    "Lease renewal: please confirm by Oct 20",
    "Hi Alex, your lease at 412 Maple Ct #3B ends Oct 31. We're offering a 12-month renewal at $2,150/month. " +
      "Please confirm by Oct 20 whether you'd like to renew. Best, Priya — Maple Court Apartments",
  ),

  // A bill: routine, low-risk, Cue can handle it.
  gmail(
    "g5", "gt_pge", "2026-10-11T13:00:00Z",
    "PG&E <billing@pge.com>", ALEX,
    "Your PG&E bill is ready",
    "Your statement is ready. Amount due: $84.12. Due date: Oct 24, 2026. AutoPay is off for this account.",
  ),

  // Alex asked the handyman for a quote five days ago and never heard back.
  gmail(
    "g6", "gt_fan", "2026-10-08T21:00:00Z",
    ALEX, "Marcus Bell <marcus@bellhandyman.com>",
    "Quote for bathroom fan?",
    "Hi Marcus, could you send a quote for replacing the bathroom exhaust fan? Any weekday after 4pm works for a visit. Thanks, Alex",
  ),

  // Mom asks a question whose answer lives in a *different inbox*.
  gmail(
    "g7", "gt_mom", "2026-10-12T22:05:00Z",
    "Linda Rivera <linda.rivera52@yahoo.com>", ALEX,
    "Thanksgiving!!",
    "Hi sweetie! Dad wants to know, are you flying in Wednesday or Thursday for Thanksgiving? He'll pick you up from the airport. Love, Mom",
  ),

  // School date: Cue can drop this on the calendar by itself.
  gmail(
    "g8", "gt_school", "2026-10-09T15:00:00Z",
    "Lincoln Elementary <office@lincolnelementary.org>", ALEX,
    "Picture Day is Wednesday, Oct 21",
    "Dear families, Picture Day for all classes is Wednesday, Oct 21. Order forms are due the same day. Please send your child in their picture-day best!",
  ),

  // Noise that should never reach the user's attention.
  gmail(
    "g9", "gt_tj", "2026-10-12T11:00:00Z",
    "Trader Joe's <news@traderjoes.com>", ALEX,
    "Fearless Flyer: pumpkin everything is back",
    "This week's deals: pumpkin bread mix, maple cookies, and more. Unsubscribe anytime.",
  ),

  // Alex is owed money by a friend.
  gmail(
    "g10", "gt_sam", "2026-10-06T03:00:00Z",
    ALEX, "Sam Ortiz <sam.ortiz@gmail.com>",
    "Concert tickets",
    "Hey Sam, I covered your ticket for the Oct 4 show ($65). Can you Venmo me when you get a chance?",
  ),
];

export const outlookMessages: OutlookRaw[] = [
  {
    id: "o1",
    conversationId: "ot_united",
    subject: "Your trip confirmation: SFO to PDX",
    receivedDateTime: "2026-09-20T19:00:00Z",
    from: { emailAddress: { name: "United Airlines", address: "receipts@united.com" } },
    toRecipients: [{ emailAddress: { name: "Alex Rivera", address: "alex.rivera@outlook.com" } }],
    body: {
      contentType: "text",
      content:
        "Confirmation K7Q2XM for Alex Rivera. Departing Wednesday, Nov 25, 2026: UA 1432 SFO 4:10 PM → PDX 5:58 PM. " +
        "Returning Sunday, Nov 29, 2026: UA 1517 PDX 6:30 PM → SFO 8:20 PM.",
    },
  },
  {
    id: "o2",
    conversationId: "ot_dentist",
    subject: "Please confirm your appointment",
    receivedDateTime: "2026-10-12T20:00:00Z",
    from: { emailAddress: { name: "Bright Smile Dental", address: "appointments@brightsmiledental.com" } },
    toRecipients: [{ emailAddress: { name: "Alex Rivera", address: "alex.rivera@outlook.com" } }],
    body: {
      contentType: "text",
      content:
        "Hi Alex, this is a reminder of your cleaning with Dr. Lee on Thursday, Oct 15 at 2:30 PM. Please reply C to confirm, or call us to reschedule.",
    },
  },
  {
    id: "o3",
    conversationId: "ot_amazon",
    subject: "Delivered: your package",
    receivedDateTime: "2026-10-12T23:40:00Z",
    from: { emailAddress: { name: "Amazon", address: "shipment-tracking@amazon.com" } },
    toRecipients: [{ emailAddress: { name: "Alex Rivera", address: "alex.rivera@outlook.com" } }],
    body: { contentType: "text", content: "Your package was delivered. It was left at the front door. Order #112-5550123." },
  },
];

export const calendarEvents: GcalRaw[] = [
  {
    id: "c1",
    summary: "Leo's birthday party",
    location: "Jumpin' Jungle",
    description: "Maya invited. Bring gift.",
    start: { dateTime: "2026-10-17T17:00:00Z" }, // Sat Oct 17, 10:00am Pacific
    end: { dateTime: "2026-10-17T19:00:00Z" },
    attendees: [{ email: "alex.rivera@gmail.com", self: true }],
  },
  {
    id: "c2",
    summary: "Hornets practice",
    location: "Garfield Park",
    start: { dateTime: "2026-10-16T00:00:00Z" }, // Thu Oct 15, 5:00pm Pacific
    end: { dateTime: "2026-10-16T01:00:00Z" },
    // Same coach, different email address and name format. Entity resolution must
    // decide (with < 100% confidence) that this is Dana Kim.
    attendees: [
      { email: "alex.rivera@gmail.com", self: true },
      { email: "dana.hornets@gmail.com", displayName: "Coach Dana" },
    ],
  },
  {
    id: "c3",
    summary: "Work: team standup",
    start: { dateTime: "2026-10-15T16:00:00Z" },
    end: { dateTime: "2026-10-15T16:30:00Z" },
    attendees: [{ email: "alex.rivera@gmail.com", self: true }],
  },
];

export const driveFiles: GdriveRaw[] = [
  {
    id: "d1",
    name: "Maya - Medical Release Form (signed).pdf",
    mimeType: "application/pdf",
    modifiedTime: "2026-09-05T02:00:00Z",
    owners: [{ displayName: "Alex Rivera", emailAddress: "alex.rivera@gmail.com" }],
    exportedText:
      "Eastside Youth Soccer medical release form. Player: Maya Rivera. Parent/guardian: Alex Rivera. Signed 9/5/2026 by Alex Rivera.",
  },
  {
    // A distractor: same form, not signed. Retrieval has to prefer the signed one.
    id: "d2",
    name: "Medical Release Form - blank.pdf",
    mimeType: "application/pdf",
    modifiedTime: "2026-09-02T18:00:00Z",
    owners: [{ displayName: "Alex Rivera", emailAddress: "alex.rivera@gmail.com" }],
    exportedText: "Eastside Youth Soccer medical release form. Player: ______ Parent/guardian signature: ______",
  },
  {
    id: "d3",
    name: "Lease - 412 Maple Ct 3B (2025-2026).pdf",
    mimeType: "application/pdf",
    modifiedTime: "2025-10-20T18:00:00Z",
    owners: [{ displayName: "Alex Rivera", emailAddress: "alex.rivera@gmail.com" }],
    permissions: [{ emailAddress: "priya@maplecourtapts.com", displayName: "Priya Shah" }],
    exportedText:
      "Residential lease, 412 Maple Ct #3B. Term: Nov 1, 2025 to Oct 31, 2026. Monthly rent: $2,050. " +
      "Renewal increases are capped at 5% of the current monthly rent.",
  },
  {
    id: "d4",
    name: "Thanksgiving 2025 photos",
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: "2025-11-30T05:00:00Z",
    owners: [{ displayName: "Alex Rivera", emailAddress: "alex.rivera@gmail.com" }],
    exportedText: "Photos from last Thanksgiving at Mom and Dad's.",
  },
];

// ---------------------------------------------------------------------------
// Long-tail apps, as an integration layer (e.g. Composio) would hand them over:
// each app's own JSON shape. Cue has no adapter for either; ingest/generic.ts
// pulls out an envelope and keeps the rest as `raw`.

const slackTs = (iso: string) => `${Date.parse(iso) / 1000}.000100`;

export const genericRecords: { accountId: string; app: string; type: string; hints?: Record<string, string>; record: Record<string, unknown> }[] = [
  {
    accountId: "acct_slack",
    app: "slack",
    type: "message",
    record: {
      type: "message",
      channel: { id: "C07HORNETS", name: "hornets-parents" },
      user: { id: "U0DANA", real_name: "Dana Kim", profile: { email: "dana.kim@eastsideyouthsoccer.org" } },
      text: "Field change for Saturday's makeup game: we're on Field 3 at Garfield Park. Please arrive by 8:30 for warm-ups. Coach Dana",
      ts: slackTs("2026-10-12T20:05:00Z"),
      permalink: "https://hornetsparents.slack.com/archives/C07HORNETS/p1760299500000100",
    },
  },
  {
    accountId: "acct_slack",
    app: "slack",
    type: "message",
    record: {
      type: "message",
      channel: { id: "C07HORNETS", name: "hornets-parents" },
      user: { id: "U0JEN", real_name: "Jen Park", profile: { email: "jen.park@gmail.com" } },
      text: "Snack sign-up for the rest of the season is in the pinned sheet. Thanks all!",
      ts: slackTs("2026-10-09T02:00:00Z"),
    },
  },
  {
    accountId: "acct_notion",
    app: "notion",
    type: "page",
    // Notion buries the title in properties; a one-line hint tells the generic mapper where.
    hints: { title: "properties.title.title" },
    record: {
      object: "page",
      id: "8a1f-apartment-notes",
      url: "https://www.notion.so/Apartment-notes-8a1f",
      last_edited_time: "2026-10-01T18:00:00Z",
      created_by: { object: "user", name: "Alex Rivera", person: { email: "alex.rivera@gmail.com" } },
      properties: { title: { title: [{ plain_text: "Apartment notes" }] } },
      content:
        "Rent budget for next year: up to $2,200/month. Priya prefers renewal decisions by email. Dishwasher repair still pending since August, mention at renewal.",
    },
  },
];

/**
 * Life topics. In production an LLM (or Graphiti's extractor) proposes these from
 * the user's data; here they are seeded so the demo is deterministic. A source
 * object is linked to a topic when it mentions enough of its keywords.
 */
export const topicSeeds = [
  { id: "topic_soccer", label: "Maya's soccer", keywords: ["hornets", "soccer", "garfield", "coach", "medical", "release", "game", "practice"] },
  { id: "topic_home", label: "Apartment & lease", keywords: ["lease", "renewal", "rent", "maple", "apartments", "landlord"] },
  { id: "topic_thanksgiving", label: "Thanksgiving trip", keywords: ["thanksgiving", "flying", "airport", "pdx", "flight", "trip", "nov"] },
  { id: "topic_school", label: "Lincoln Elementary", keywords: ["school", "picture", "families", "classes", "elementary"] },
  { id: "topic_health", label: "Health appointments", keywords: ["dental", "appointment", "cleaning", "dr", "doctor"] },
  { id: "topic_home_repair", label: "Home repairs", keywords: ["fan", "quote", "exhaust", "bathroom", "repair"] },
];
