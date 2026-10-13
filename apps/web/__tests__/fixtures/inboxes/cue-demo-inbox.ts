import type {
  ComposioEmulatorCanvasEvent,
  ComposioEmulatorDriveFile,
} from "@/__tests__/emulators/composio";
import type {
  DemoInboxAddress,
  DemoInboxFixture,
  DemoInboxMessage,
  DemoInboxThread,
} from "@/__tests__/fixtures/inboxes/types";

// Cue's local demo: David Lin, a college senior recruiting for new-grad roles
// while working part time at a startup. He has two mailboxes: a school Gmail
// for recruiting, school, and family, and a work Outlook at Brightline for the
// customer renewal. Threads are written to connect: the customer renewal has
// an older thread with the same person, an internal pricing email, an
// engineering update, and meetings on the work calendar.
//
// Dates are relative to `now` so the inbox always looks current; the
// emulator's mailbox sync only covers recent mail.

const DAVID = person("David Lin", "david.lin@ucsd.edu");
const DAVID_AT_WORK = person("David Lin", "david@brightline.io");
const SARAH = person("Sarah Chen", "sarah@acmecorp.com");
const PRIYA = person("Priya Nair", "priya@brightline.io");
const MARCUS = person("Marcus Webb", "marcus@brightline.io");
const JESSICA = person("Jessica Park", "jessica.park@nvidia.com");
const KEVIN = person("Kevin Ruiz", "kruiz@ucsd.edu");
const MOM = person("Linda Lin", "linda.lin@gmail.com");
const ALEX = person("Alex Kim", "akim@chicagotrading.com");
const MAYA = person("Maya Ortiz", "mortiz@waymo.com");

/** David's school Gmail: recruiting, school, family, and everything automated. */
export function buildCueDemoInbox(now = new Date()): DemoInboxFixture {
  const threads = buildCueDemoThreads(now).school;
  return {
    id: "cueStudentProfessional",
    name: "Cue demo: student + young professional",
    description:
      "A college senior's school Gmail: recruiting for new-grad roles, a class project, family, and newsletters.",
    mailbox: {
      email: DAVID.email,
      displayName: "David Lin",
      timezone: "America/Los_Angeles",
    },
    labels: labels(threads),
    threads,
  };
}

/** David's work Outlook at Brightline: the Acme renewal and what surrounds it. */
export function buildCueDemoWorkInbox(now = new Date()): DemoInboxFixture {
  const threads = buildCueDemoThreads(now).work;
  return {
    id: "cueStudentProfessionalWork",
    name: "Cue demo: part-time job at a startup",
    description:
      "The same student's work Outlook: a customer renewal, the SSO incident behind it, internal pricing, and an engineering update.",
    mailbox: {
      email: DAVID_AT_WORK.email,
      displayName: "David Lin",
      timezone: "America/Los_Angeles",
    },
    labels: labels(threads),
    threads,
  };
}

// Both mailboxes come from one sequence so message ids stay stable.
function buildCueDemoThreads(now: Date) {
  const ago = (hours: number) =>
    new Date(now.getTime() - hours * 3_600_000).toISOString();
  let seq = 0;
  // Gmail-style 16-hex-character ids, stable across runs.
  const id = () => `c0e${(++seq).toString(16).padStart(13, "0")}`;

  const work = [
    // The Acme renewal and everything around it.
    thread(id(), [
      workMessage({
        id: id(),
        from: SARAH,
        subject: "Renewal discussion & updated pricing",
        bodyText:
          "Hi David,\n\nFollowing up on the SSO security issue from last week: can you confirm it's resolved on your side?\n\nAlso, could you send the updated enterprise pricing sheet before our renewal meeting on Friday? We're considering a 3-year term, but we need to stay within budget.\n\nThanks,\nSarah",
        unread: true,
        labels: ["CATEGORY_PERSONAL", "INBOX", "To Reply", "Work"],
        date: ago(2),
      }),
    ]),
    thread(id(), [
      workMessage({
        id: id(),
        from: SARAH,
        subject: "SSO login failures for Acme users",
        bodyText:
          "Hi David, several of our users haven't been able to log in with SSO since Tuesday. It's blocking our support team. Can you look into it?",
        labels: ["CATEGORY_PERSONAL", "Work"],
        date: ago(24 * 9 + 3),
      }),
      workMessage({
        id: id(),
        from: DAVID_AT_WORK,
        to: [SARAH],
        subject: "Re: SSO login failures for Acme users",
        bodyText:
          "Thanks Sarah. Engineering is tracking this as ACME-482. I'll update you as soon as the fix ships.",
        labels: ["SENT"],
        date: ago(24 * 9),
      }),
    ]),
    thread(id(), [
      workMessage({
        id: id(),
        from: PRIYA,
        subject: "Enterprise pricing v3",
        bodyText:
          "Hi David, the latest enterprise pricing sheet (v3) is in the shared drive. Use this one for the Acme renewal. Multi-year terms get 12% off list, and we can go to 15% for a 3-year commitment.\n\nPriya",
        labels: ["CATEGORY_PERSONAL", "FYI"],
        date: ago(24 * 3 + 5),
      }),
    ]),
    thread(id(), [
      workMessage({
        id: id(),
        from: MARCUS,
        cc: [PRIYA],
        subject: "ACME-482: SSO security patch deployed",
        bodyText:
          "Heads up: the fix for ACME-482 (SSO login failures) went to production last night. Acme users can sign in again. The security review is closed.",
        labels: ["CATEGORY_PERSONAL", "FYI"],
        date: ago(20),
      }),
    ]),
  ];

  const school = [
    // --- Recruiting ----------------------------------------------------------
    thread(id(), [
      message({
        id: id(),
        from: JESSICA,
        subject: "Next steps: NVIDIA Software Engineer, New College Grad",
        bodyText:
          "Hi David,\n\nCongrats on passing the online assessment! Could you share your availability for two 45-minute technical interviews next week? Mornings Pacific time work best for the team.\n\nBest,\nJessica Park\nUniversity Recruiting, NVIDIA",
        unread: true,
        labels: ["CATEGORY_PERSONAL", "INBOX", "To Reply", "Recruiting"],
        date: ago(5),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person(
          "NVIDIA University Recruiting",
          "university-recruiting@nvidia.com",
        ),
        subject: "Final reminder: register for the new-grad webinar",
        bodyText:
          "Meet NVIDIA's new-grad software engineering team at our virtual webinar this Wednesday at noon Pacific. Register to save your spot.",
        labels: ["CATEGORY_PROMOTIONS", "INBOX", "Recruiting"],
        date: ago(26),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: ALEX,
        subject: "Superday scheduling",
        bodyText:
          "Hi David, we'd love to bring you in for a Superday. Do October 22 or October 23 work for you?",
        labels: ["CATEGORY_PERSONAL", "Recruiting"],
        date: ago(24 * 4),
      }),
      message({
        id: id(),
        from: DAVID,
        to: [ALEX],
        subject: "Re: Superday scheduling",
        bodyText:
          "Thanks Alex! October 22 works best for me. Could you confirm the start time and location?",
        labels: ["SENT", "Awaiting Reply"],
        date: ago(24 * 3),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: DAVID,
        to: [MAYA],
        subject: "Following up on my application",
        bodyText:
          "Hi Maya, I wanted to follow up on my application for the Software Engineer, Simulation role. Is there any update on next steps?",
        labels: ["SENT", "Awaiting Reply"],
        date: ago(24 * 6),
      }),
    ]),

    // --- School --------------------------------------------------------------
    thread(id(), [
      message({
        id: id(),
        from: KEVIN,
        subject: "CSE 151B milestone 2: meet Wednesday?",
        bodyText:
          "Hey David, milestone 2 is due Friday. Can we meet Wednesday at 4pm in the CSE building to finish the evaluation section? I can make the plots if you take the write-up.",
        unread: true,
        labels: ["CATEGORY_PERSONAL", "INBOX", "To Reply"],
        date: ago(3),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("Prof. Rosa Alvarez", "ralvarez@ucsd.edu"),
        to: [person("CSE 151B students", "cse151b-students@ucsd.edu")],
        subject: "CSE 151B: milestone 2 due Friday at 11:59pm",
        bodyText:
          "Reminder: milestone 2 (model evaluation and write-up) is due Friday at 11:59pm. Each group submits one PDF. Office hours are Wednesday 2-4pm.",
        labels: ["CATEGORY_UPDATES", "INBOX", "FYI"],
        date: ago(24 * 2),
      }),
    ]),

    // --- Family --------------------------------------------------------------
    thread(id(), [
      message({
        id: id(),
        from: MOM,
        subject: "Thanksgiving flight?",
        bodyText:
          "Hi honey, is your flight home Wednesday or Thursday for Thanksgiving? Dad will pick you up at SFO, and which terminal do you land at? Dad wants to park close. Love, Mom",
        unread: true,
        labels: ["CATEGORY_PERSONAL", "INBOX", "To Reply"],
        date: ago(6),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("United Airlines", "receipts@united.com"),
        subject: "Your trip confirmation: SAN to SFO",
        bodyText:
          "Your flight is confirmed. Confirmation PX7Q2M for David Lin. Departing Wednesday, November 25: flight UA 2231, SAN 5:05 PM to SFO 6:35 PM. Returning Sunday, November 29.",
        labels: ["CATEGORY_UPDATES", "Receipt"],
        date: ago(24 * 20),
      }),
    ]),

    // --- Sorted automatically: labeled, but still in the inbox ---------------
    thread(id(), [
      message({
        id: id(),
        from: person("Handshake", "notifications@joinhandshake.com"),
        subject: "New event: Tech & Finance Career Series",
        bodyText:
          "You might be interested in this event: Tech & Finance Career Series, next Tuesday at 6pm.\n\nSee details and RSVP: https://app.joinhandshake.com/events/1428571",
        labels: ["CATEGORY_UPDATES", "INBOX", "Notification"],
        date: ago(23),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("Spotify", "no-reply@spotify.com"),
        subject: "Premium Student: your first month is on us",
        bodyText:
          "Students get Premium for less. Try it free for one month, then $5.99/month. Offer ends Sunday.",
        labels: ["CATEGORY_PROMOTIONS", "INBOX", "Marketing"],
        date: ago(22),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("Triton Today", "tritontoday@ucsd.edu"),
        subject: "Triton Today: fall career fair recap",
        bodyText:
          "Over 3,000 students attended this year's fall career fair. Here's what employers said they're looking for.",
        labels: ["CATEGORY_UPDATES", "INBOX", "Newsletter"],
        date: ago(24 * 2 + 4),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("Venmo", "venmo@venmo.com"),
        subject: "You paid Kevin Ruiz $18.50",
        bodyText: "You paid Kevin Ruiz $18.50 for pizza.",
        labels: ["CATEGORY_UPDATES", "INBOX", "Receipt"],
        date: ago(24 * 2 + 1),
      }),
    ]),
    thread(id(), [
      message({
        id: id(),
        from: person("LinkedIn Job Alerts", "jobalerts-noreply@linkedin.com"),
        subject: "12 new jobs for Software Engineer, New Grad",
        bodyText: "New jobs matching your alert in San Diego and the Bay Area.",
        labels: ["CATEGORY_SOCIAL", "INBOX", "Notification"],
        date: ago(18),
      }),
    ]),
  ];

  return { work, school };
}

export type CueDemoCalendarEvent = {
  id: string;
  user_email: string;
  calendar_id: string;
  summary: string;
  description?: string;
  location?: string;
  start_date_time: string;
  end_date_time: string;
  attendees: { email: string; display_name?: string }[];
};

/** School meetings for the Gmail calendar, placed relative to `now` in Pacific time. */
export function buildCueDemoCalendarEvents(
  userEmail: string,
  now = new Date(),
): CueDemoCalendarEvent[] {
  return [
    calendarEvent(
      userEmail,
      "cue_evt_cse151b",
      "CSE 151B group meeting",
      nextWeekday(now, 3, 16),
      60,
      [KEVIN],
      { location: "CSE Building, room 1202" },
    ),
    calendarEvent(
      userEmail,
      "cue_evt_nvidia_webinar",
      "NVIDIA new-grad webinar",
      nextWeekday(now, 3, 12),
      45,
      [],
      {
        description:
          "Virtual webinar with NVIDIA's new-grad software engineering team.",
      },
    ),
  ];
}

/** Acme meetings for the work Outlook calendar, placed like the school ones. */
export function buildCueDemoWorkCalendarEvents(
  userEmail: string,
  now = new Date(),
): CueDemoCalendarEvent[] {
  return [
    calendarEvent(
      userEmail,
      "cue_evt_acme_renewal",
      "Acme renewal meeting",
      nextWeekday(now, 5, 10),
      60,
      [SARAH, PRIYA],
      { description: "3-year renewal and enterprise pricing." },
    ),
    calendarEvent(
      userEmail,
      "cue_evt_call_sarah",
      "Call with Sarah (Acme)",
      lastWeekday(now, 4, 14),
      30,
      [SARAH],
      {
        description:
          "Sarah mentioned budget concerns and interest in a 3-year term.",
      },
    ),
  ];
}

/**
 * What David's connected Google Drive and Canvas hold, for the Composio
 * emulator: the pricing sheet Priya's email points to, the write-up Kevin's
 * thread is about, and the milestone the course announcement reminds of.
 */
export function buildCueDemoConnectorData(now = new Date()): {
  driveFiles: ComposioEmulatorDriveFile[];
  canvasEvents: ComposioEmulatorCanvasEvent[];
} {
  const dueAt = new Date(
    nextWeekday(now, 5, 23).getTime() + 59 * 60_000,
  ).toISOString();
  const assignmentUrl =
    "https://canvas.ucsd.edu/courses/61234/assignments/812345";
  const description =
    "<p>Evaluate your CSE 151B model on the held-out test set and finish the <strong>evaluation section</strong>: metrics, plots, and error analysis.</p><p>Submit the write-up as one PDF per group by Friday at 11:59pm.</p>";

  return {
    driveFiles: [
      {
        id: "cue-demo-enterprise-pricing-v3",
        name: "Enterprise pricing v3",
        mimeType: "application/vnd.google-apps.spreadsheet",
        modifiedTime: new Date(now.getTime() - 26 * 3_600_000).toISOString(),
        webViewLink:
          "https://docs.google.com/spreadsheets/d/cue-demo-enterprise-pricing-v3/edit",
        owners: [{ displayName: "Priya Nair", emailAddress: PRIYA.email }],
      },
      {
        id: "cue-demo-cse151b-milestone-2",
        name: "CSE 151B milestone 2 write-up",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: new Date(now.getTime() - 20 * 3_600_000).toISOString(),
        webViewLink:
          "https://docs.google.com/document/d/cue-demo-cse151b-milestone-2/edit",
        owners: [{ displayName: "Kevin Ruiz", emailAddress: KEVIN.email }],
      },
    ],
    canvasEvents: [
      {
        id: 812_345,
        title: "Milestone 2: model evaluation and write-up",
        description,
        start_at: dueAt,
        end_at: dueAt,
        html_url: assignmentUrl,
        context_name: "CSE 151B",
        assignment: { due_at: dueAt, description, html_url: assignmentUrl },
      },
    ],
  };
}

// Pacific daylight time is UTC-7; close enough for demo data.
const PACIFIC_OFFSET_HOURS = 7;

function nextWeekday(now: Date, weekday: number, hourPacific: number) {
  const days = (weekday - now.getUTCDay() + 7) % 7 || 7;
  return atPacificHour(now, days, hourPacific);
}

function lastWeekday(now: Date, weekday: number, hourPacific: number) {
  const days = (now.getUTCDay() - weekday + 7) % 7 || 7;
  return atPacificHour(now, -days, hourPacific);
}

function atPacificHour(now: Date, dayOffset: number, hourPacific: number) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourPacific + PACIFIC_OFFSET_HOURS, 0, 0, 0);
  return d;
}

function calendarEvent(
  userEmail: string,
  id: string,
  summary: string,
  start: Date,
  minutes: number,
  attendees: DemoInboxAddress[],
  extra: { description?: string; location?: string } = {},
): CueDemoCalendarEvent {
  return {
    id,
    user_email: userEmail,
    calendar_id: "primary",
    summary,
    start_date_time: start.toISOString(),
    end_date_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
    attendees: [
      { email: userEmail, display_name: "David Lin" },
      ...attendees.map((a) => ({ email: a.email, display_name: a.name })),
    ],
    ...extra,
  };
}

/** The system labels, plus the user labels these threads use. */
function labels(threads: DemoInboxThread[]) {
  const used = new Set(
    threads.flatMap((t) => t.messages.flatMap((m) => m.labels ?? [])),
  );
  const user = (name: string) => ({
    id: `Label_${name}`,
    name,
    type: "user" as const,
  });
  return [
    { id: "INBOX", name: "INBOX", type: "system" as const },
    { id: "UNREAD", name: "UNREAD", type: "system" as const },
    { id: "SENT", name: "SENT", type: "system" as const },
    // Gmail sorts every received email into one of its inbox tabs.
    ...[
      "CATEGORY_PERSONAL",
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "CATEGORY_UPDATES",
    ].map((id) => ({ id, name: id, type: "system" as const })),
    ...[
      "To Reply",
      "Awaiting Reply",
      "FYI",
      "Work",
      "Recruiting",
      "Newsletter",
      "Marketing",
      "Receipt",
      "Notification",
    ]
      .filter((name) => used.has(name))
      .map(user),
  ];
}

function thread(id: string, messages: DemoInboxMessage[]): DemoInboxThread {
  return { id, messages };
}

function message({
  to,
  ...rest
}: Omit<DemoInboxMessage, "to"> & {
  to?: DemoInboxAddress[];
}): DemoInboxMessage {
  return { to: to ?? [DAVID], ...rest };
}

function workMessage({
  to,
  ...rest
}: Omit<DemoInboxMessage, "to"> & {
  to?: DemoInboxAddress[];
}): DemoInboxMessage {
  return { to: to ?? [DAVID_AT_WORK], ...rest };
}

function person(name: string, email: string): DemoInboxAddress {
  return { name, email };
}

/**
 * What a model would write for the thread brief on Home. Local dev runs an LLM
 * emulator that answers with placeholders, so `pnpm local:start` registers
 * these as its scripted replies, matched by subject. A real model replaces
 * them as soon as an AI provider is configured.
 */
export const cueDemoThreadBriefs: {
  subject: string;
  summary: string;
  keyPoints: string[];
}[] = [
  {
    subject: "Renewal discussion & updated pricing",
    summary:
      "Sarah is following up on last week's SSO security issue and wants the updated enterprise pricing before Friday's renewal meeting.",
    keyPoints: [
      "Confirm the SSO security issue (ACME-482) is resolved.",
      "Send the latest enterprise pricing sheet.",
      "Acme is considering a 3-year term but is watching budget.",
      "Renewal meeting is this Friday.",
    ],
  },
  {
    subject: "CSE 151B milestone 2: meet Wednesday?",
    summary:
      "Kevin wants to meet Wednesday at 4pm to finish milestone 2, which is due Friday.",
    keyPoints: [
      "Proposed time: Wednesday 4pm, CSE building.",
      "Kevin makes the plots; you take the write-up.",
      "Milestone 2 is due Friday at 11:59pm.",
    ],
  },
  {
    subject: "Next steps: NVIDIA Software Engineer, New College Grad",
    summary:
      "You passed NVIDIA's online assessment, and Jessica needs your availability for two technical interviews next week.",
    keyPoints: [
      "Two 45-minute technical interviews.",
      "Mornings Pacific time work best for the team.",
    ],
  },
  {
    subject: "Thanksgiving flight?",
    summary:
      "Mom is asking which day you fly home for Thanksgiving so Dad can pick you up at SFO.",
    keyPoints: [
      "Your United confirmation shows Wednesday, Nov 25, landing at SFO at 6:35pm.",
    ],
  },
  {
    subject: "Superday scheduling",
    summary:
      "You told Alex that October 22 works for the Chicago Trading Company Superday and asked for the start time and location.",
    keyPoints: ["Waiting on Alex to confirm time and location."],
  },
  {
    subject: "Following up on my application",
    summary:
      "You followed up with Maya at Waymo about the Software Engineer, Simulation role and haven't heard back.",
    keyPoints: ["No reply in 6 days. Consider a short nudge."],
  },
];

/**
 * What a model would answer when asked to suggest a reply, for three threads
 * that show each outcome: a reply backed by the thread itself, an abstention
 * that a web search settles, and an abstention. Matched by the thread's subject, like the
 * briefs. Quotes are exact text from the fixture, so they pass the same check
 * a real model's do; source ids follow the context ranking for these threads.
 */
export const cueDemoReplySuggestions: {
  subject: string;
  object: {
    enoughEvidence: boolean;
    missing: string;
    webQuery: string;
    reply: string;
    claims: { fact: string; sourceId: string; quote: string }[];
  };
}[] = [
  {
    subject: "CSE 151B milestone 2: meet Wednesday?",
    object: {
      enoughEvidence: true,
      missing: "",
      webQuery: "",
      reply:
        "Hey Kevin, Wednesday at 4pm in the CSE building works. I'll take the write-up if you make the plots, so we can submit before the Friday 11:59pm deadline.",
      claims: [
        {
          fact: "Meet Wednesday at 4pm in the CSE building",
          sourceId: "m1",
          quote: "Can we meet Wednesday at 4pm in the CSE building",
        },
        {
          fact: "Kevin makes the plots and David takes the write-up",
          sourceId: "m1",
          quote: "I can make the plots if you take the write-up",
        },
        {
          fact: "Milestone 2 is due Friday at 11:59pm",
          // The write-up in Drive and the group meeting rank above it.
          sourceId: "c3",
          quote: "is due Friday at 11:59pm",
        },
      ],
    },
  },
  {
    // Searching the web settles it: see cueDemoWebReply in cue-demo-web.ts.
    subject: "Thanksgiving flight?",
    object: {
      enoughEvidence: false,
      missing:
        "Which SFO terminal your United flight lands at. Your trip confirmation has the day and time, but not the terminal.",
      webQuery: "SFO United domestic arrivals terminal",
      reply: "",
      claims: [],
    },
  },
  {
    subject: "Renewal discussion & updated pricing",
    object: {
      enoughEvidence: false,
      missing:
        "The updated prices. Marcus confirmed the SSO fix shipped, and the v3 pricing sheet is in Google Drive, but Cue can see only its title, not the prices.",
      // Private pricing: nothing public settles it, so there's no web search.
      webQuery: "",
      reply: "",
      claims: [],
    },
  },
];

type DemoInsight = {
  action: "reply" | "do" | "none";
  task: string;
  date: string;
  dateRole: "deadline" | "expires" | "event" | "none";
  fact: string;
  factLabel: string;
};

/**
 * What a model would note under each demo email in the inbox, matched by
 * subject like the briefs. Dates are relative to `now` so "Friday" stays the
 * coming Friday; facts are exact text from the emails, as the real check
 * requires. Emails that ask nothing get an empty insight: no line at all.
 */
export function buildCueDemoInsights(
  now = new Date(),
): { subject: string; object: DemoInsight }[] {
  const empty: DemoInsight = {
    action: "none",
    task: "",
    date: "",
    dateRole: "none",
    fact: "",
    factLabel: "",
  };
  const at = (d: Date, minutes = 0) =>
    new Date(d.getTime() + minutes * 60_000).toISOString();
  const friday = nextWeekday(now, 5, 17);
  const wednesday = (hour: number) => nextWeekday(now, 3, hour);

  return [
    {
      subject: "Renewal discussion & updated pricing",
      object: {
        ...empty,
        action: "reply",
        task: "Confirm the SSO fix and send updated pricing",
        date: at(friday),
        dateRole: "deadline",
      },
    },
    {
      subject: "Next steps: NVIDIA Software Engineer, New College Grad",
      object: {
        ...empty,
        action: "reply",
        task: "Share availability for 2 technical interviews",
        fact: "Mornings Pacific time work best",
      },
    },
    {
      subject: "Final reminder: register for the new-grad webinar",
      object: {
        ...empty,
        action: "do",
        task: "Register for the new-grad webinar",
        date: at(wednesday(12)),
        dateRole: "event",
      },
    },
    {
      subject: "CSE 151B milestone 2: meet Wednesday?",
      object: {
        ...empty,
        action: "reply",
        task: "Confirm meeting Wednesday 4pm",
        fact: "CSE building",
        factLabel: "At",
      },
    },
    {
      subject: "CSE 151B: milestone 2 due Friday at 11:59pm",
      object: {
        ...empty,
        date: at(nextWeekday(now, 5, 23), 59),
        dateRole: "deadline",
        fact: "Each group submits one PDF",
      },
    },
    {
      subject: "Thanksgiving flight?",
      object: {
        ...empty,
        action: "reply",
        task: "Tell Mom which day you fly home",
      },
    },
    {
      subject: "New event: Tech & Finance Career Series",
      object: {
        ...empty,
        date: at(nextWeekday(now, 2, 18)),
        dateRole: "event",
      },
    },
    {
      subject: "You paid Kevin Ruiz $18.50",
      object: { ...empty, fact: "$18.50", factLabel: "Paid" },
    },
    {
      subject: "Premium Student: your first month is on us",
      object: {
        ...empty,
        date: at(nextWeekday(now, 0, 23), 59),
        dateRole: "expires",
      },
    },
    { subject: "Triton Today: fall career fair recap", object: empty },
    {
      subject: "Enterprise pricing v3",
      object: {
        ...empty,
        fact: "15% for a 3-year commitment",
      },
    },
    {
      subject: "ACME-482: SSO security patch deployed",
      object: { ...empty, fact: "Acme users can sign in again" },
    },
    {
      subject: "Your trip confirmation: SAN to SFO",
      object: {
        ...empty,
        date: "2026-11-25",
        dateRole: "event",
        fact: "PX7Q2M",
        factLabel: "Confirmation",
      },
    },
    { subject: "12 new jobs for Software Engineer, New Grad", object: empty },
  ];
}

/**
 * The demo's one chat exchange, asked from the search box: the assistant
 * searches mail, calendar and apps, then answers from what it found. The
 * answer is matched on text only the search results contain.
 */
export const cueDemoChat = {
  question: "When is milestone 2 due?",
  search: { query: "milestone 2 due" },
  answerAfter: "Each group submits one PDF",
  answer:
    'Milestone 2 for CSE 151B is due **Friday at 11:59pm**. Each group submits one PDF.\n\nSources: Prof. Alvarez\'s email "CSE 151B: milestone 2 due Friday at 11:59pm", and the Canvas assignment "Milestone 2: model evaluation and write-up". Kevin also asked to meet Wednesday at 4pm in the CSE building to finish it.',
};
