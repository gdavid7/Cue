import { TZDate } from "@date-fns/tz";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import type { SearchLabel } from "@/utils/mail-search/search-query-predicate";

/**
 * A synthetic mailbox for the search-retrieval eval: one person's mail from
 * November 2025 to mid-October 2026. Every person, company and address is
 * invented (`.example` domains); none of it is real mail.
 */

export const ACCOUNT_ID = "acc-retrieval";
export const TIMEZONE = "America/Los_Angeles";
// A Monday, as in the search-intent eval.
export const NOW = new Date("2026-10-19T17:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

export const LABELS: SearchLabel[] = [
  { id: "Label_receipts", name: "Receipts" },
  { id: "Label_travel", name: "Travel" },
  { id: "Label_clients", name: "Work/Clients" },
  { id: "Label_taxes", name: "Taxes" },
  { id: "Label_home", name: "Home" },
];

type LabelName = "Receipts" | "Travel" | "Work/Clients" | "Taxes" | "Home";

export type FixtureEmail = {
  id: string;
  /** Messages sharing a thread are one conversation; defaults to the id. */
  thread?: string;
  /** Local time in the account's time zone, "YYYY-MM-DD HH:mm". */
  at: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** File names, for the reader; the store only learns that a file is attached. */
  attachments?: string[];
  labels?: LabelName[];
  read?: boolean;
  starred?: boolean;
  /** Where the message lives; inbox by default. */
  box?: "inbox" | "archive" | "sent" | "spam";
  category?: "promotions" | "updates" | "social";
};

const ME = "Alex Rivera <alex.rivera@example.com>";
const SARAH_KIM = "Sarah Kim <sarah.kim@lumenworks.example>";
const SARAH_PATEL = "Sarah Patel <sarahp@mailbox.example>";
const PRIYA = "Priya Raman <priya.raman@lumenworks.example>";
const TOM = "Tom Becker <tom.becker@lumenworks.example>";
const FINANCE = "Lumenworks Finance <finance@lumenworks.example>";
const PAYROLL = "Lumenworks Payroll <payroll@lumenworks.example>";
const HIROSHI = "Hiroshi Tanaka <h.tanaka@kumo-systems.example>";
const HIROSHI_JA = "田中 博 <h.tanaka@kumo-systems.example>";
const DIANE =
  "Diane Ortiz (Greenleaf Property Mgmt) <diane@greenleafpm.example>";
const GREENLEAF = "Greenleaf Property Management <noreply@greenleafpm.example>";
const MOM = "Elena Rivera <elena.rivera@mailbox.example>";
const CARLOS = "Carlos Mendoza <carlos.mendoza@correo.example>";
const SKYLINE = "Skyline Air <reservations@skylineair.example>";
const SKYLINE_DEALS = "Skyline Air <deals@skylineair.example>";
const BAYLINE = "Bayline Energy <billing@baylineenergy.example>";
const PARCELLY = "Parcelly <orders@parcelly.example>";
const PARCELLY_DEALS = "Parcelly Deals <deals@parcelly.example>";
const COFFEE = "Ridgeline Coffee <orders@ridgelinecoffee.example>";
const DENTAL = "Brightsmile Dental <appointments@brightsmiledental.example>";
const SCHOOL = "Maple Grove Elementary <office@maplegrove-school.example>";
const BANK = "Harborview Credit Union <notices@harborviewcu.example>";
const CPA = "Nina Brooks CPA <nina@brookstax.example>";
const RAVI = "Ravi Shah <ravi@northpeak-analytics.example>";
const LEGAL = "Lumenworks Legal <legal@lumenworks.example>";
const CABIN = "Pine Hollow Cabins <host@pinehollow.example>";
const HOTEL_LISBON = "Casa Alfama Hotel <reservas@casa-alfama.example>";
const HOTEL_DENVER = "Mile High Suites <stay@milehighsuites.example>";
const BUYER = "Jordan Ellis <jordan.ellis88@mailbox.example>";
const PLUMBER = "Rapid Flow Plumbing <office@rapidflow.example>";
const LENA = "Lena Okafor <lena.okafor@mailbox.example>";
const MARCO = "Marco Bellini <marco.b@mailbox.example>";
const CONF =
  "DevSummit West Program Committee <speakers@devsummitwest.example>";
const MOTOR = "State Motor Services <no-reply@motorservices.example>";
const BEN = "Ben Alvarez (Alvarez Remodeling) <ben@alvarezremodel.example>";
const MORNING_BYTE = "The Morning Byte <hello@morningbyte.example>";
const RUNNERS = "Trailhead Runners <club@trailheadrunners.example>";
const CODEFORGE = "CodeForge <notifications@codeforge.example>";
const KITCHEN_NEWS = "Weeknight Kitchen <recipes@weeknightkitchen.example>";
const REFUND_SPAM = "Air Refund Center <claims@refund-desk.example>";

const HAND_WRITTEN: FixtureEmail[] = [
  // Work: the team offsite.
  {
    id: "offsite-sarah-1",
    thread: "t-offsite-dates",
    at: "2026-09-02 10:14",
    from: SARAH_KIM,
    to: [ME, TOM, PRIYA],
    subject: "Team offsite — proposed dates",
    body: "Hi all, I'm pulling together the fall offsite. Thinking Oct 22-23 at Redwood Lodge in Santa Cruz. Can everyone hold those dates? Agenda to follow. — Sarah",
  },
  {
    id: "offsite-tom-reply",
    thread: "t-offsite-dates",
    at: "2026-09-02 11:30",
    from: TOM,
    to: [SARAH_KIM, ME, PRIYA],
    subject: "Re: Team offsite — proposed dates",
    body: "Works for me. Can we squeeze in a hike on day two?",
  },
  {
    id: "offsite-sarah-2",
    at: "2026-09-18 16:05",
    from: SARAH_KIM,
    to: [ME, TOM, PRIYA],
    subject: "Offsite agenda + carpools",
    body: "Agenda attached. Day one is 2027 roadmap planning, day two is the hike Tom asked for. I'll organize carpools from the office at 8am.",
    attachments: ["offsite-agenda.pdf"],
  },
  {
    id: "offsite-sarah-3",
    at: "2026-10-14 09:40",
    from: SARAH_KIM,
    to: [ME, TOM, PRIYA],
    subject: "Quick update: venue change",
    body: "Heads up — Redwood Lodge double-booked us, so the offsite moves to Seabright Retreat Center, same dates. Dietary restrictions to me by Friday please.",
    read: false,
  },
  {
    id: "offsite-priya-budget",
    at: "2026-09-25 13:12",
    from: PRIYA,
    to: [SARAH_KIM],
    cc: [ME],
    subject: "Re: offsite costs",
    body: "Sarah, I approved $4,000 for the offsite including lodging and the bus. Keep receipts for finance.",
  },
  {
    id: "sarah-design-review",
    at: "2026-08-12 15:20",
    from: SARAH_KIM,
    to: [ME],
    subject: "Design review notes",
    body: "Notes from today's design review for Atlas onboarding: simplify step two, drop the tour, and keep the import screen.",
  },
  {
    id: "sarah-patel-block-party",
    at: "2026-09-20 08:02",
    from: SARAH_PATEL,
    to: [ME],
    subject: "Block party Saturday!",
    body: "Hi neighbors, the Elm St block party is this Saturday at 4pm. Bring a dish and a chair! — Sarah (#14)",
    category: "social",
  },
  // Work: budgets.
  {
    id: "budget-q3-priya-1",
    thread: "t-q3-planning",
    at: "2026-07-08 09:00",
    from: PRIYA,
    to: [ME],
    subject: "Q3 budget planning",
    body: "Alex, please send your team's Q3 budget requests by July 15. Headcount stays flat but there's room for tooling.",
  },
  {
    id: "budget-q3-alex",
    thread: "t-q3-planning",
    at: "2026-07-14 17:45",
    from: ME,
    to: [PRIYA],
    subject: "Re: Q3 budget planning",
    body: "Attached are our Q3 requests — mostly observability tooling and one contractor.",
    attachments: ["platform-q3-requests.xlsx"],
    box: "sent",
  },
  {
    id: "budget-q3-priya-2",
    at: "2026-07-21 11:10",
    from: PRIYA,
    to: [ME],
    subject: "Q3 budget decisions",
    body: "Approved everything for Q3 except the contractor; let's revisit that in Q4 planning.",
  },
  {
    id: "budget-q2-priya",
    at: "2026-04-06 09:30",
    from: PRIYA,
    to: [ME],
    subject: "Q2 budget planning",
    body: "Q2 budget requests are due April 10. Same template as last quarter.",
  },
  {
    id: "finance-q3-actuals",
    at: "2026-10-02 07:00",
    from: FINANCE,
    to: [ME],
    subject: "Q3 budget actuals are ready",
    body: "Q3 actuals versus budget are now in the finance dashboard. Variances over 10% need a note by Oct 9.",
    category: "updates",
  },
  // Work: mail sent to Tom.
  {
    id: "sent-tom-1",
    thread: "t-atlas-checklist",
    at: "2026-10-13 14:20",
    from: ME,
    to: [TOM],
    subject: "Atlas migration checklist",
    body: "Tom, here's the checklist we discussed: freeze writes, snapshot, run the backfill, flip the flag. Shout if I missed anything.",
    box: "sent",
  },
  {
    id: "tom-checklist-reply",
    thread: "t-atlas-checklist",
    at: "2026-10-15 10:02",
    from: TOM,
    to: [ME],
    subject: "Re: Atlas migration checklist",
    body: "Looks right. I'd add a rollback drill before flipping the flag.",
  },
  {
    id: "sent-tom-2",
    at: "2026-10-16 09:05",
    from: ME,
    to: [TOM],
    subject: "Coverage while I'm out Friday",
    body: "Can you cover the on-call handoff Friday? I'm at the dentist in the afternoon... kidding, it's a school thing. Thanks!",
    box: "sent",
  },
  {
    id: "sent-tom-old",
    at: "2026-09-29 12:15",
    from: ME,
    to: [TOM],
    subject: "Lunch Thursday?",
    body: "Ramen place on 3rd, Thursday at noon?",
    box: "sent",
  },
  {
    id: "sent-priya-headcount",
    at: "2026-10-14 16:40",
    from: ME,
    to: [PRIYA],
    subject: "Headcount ask for Q4",
    body: "Priya, a short case for one more SRE in Q4 is attached.",
    attachments: ["q4-sre-case.pdf"],
    box: "sent",
  },
  // Work: Tom's attachments.
  {
    id: "tom-sheet-capacity",
    at: "2026-08-20 10:30",
    from: TOM,
    to: [ME],
    subject: "Capacity numbers for Q4 planning",
    body: "Here are the numbers, broken down by squad. Second tab has the on-call load.",
    attachments: ["q4-capacity.xlsx"],
  },
  {
    id: "tom-sheet-vendors",
    at: "2026-10-01 15:55",
    from: TOM,
    to: [ME],
    subject: "Updated vendor cost comparison",
    body: "Attached the updated comparison — I added the Northpeak quote as a new column and sorted by annual cost.",
    attachments: ["vendor-costs.xlsx"],
  },
  {
    id: "tom-slides",
    at: "2026-09-11 18:20",
    from: TOM,
    to: [ME],
    subject: "Slides from the all-hands",
    body: "Deck from today, in case you want the reliability slide for your team.",
    attachments: ["all-hands-sept.pptx"],
  },
  // Work: the Atlas client integration.
  {
    id: "atlas-hiroshi-1",
    at: "2026-09-10 08:45",
    from: HIROSHI,
    to: [ME],
    subject: "Atlas integration — API keys and sandbox",
    body: "Hi Alex, sandbox credentials for the Atlas integration are in the vault. Rate limit is 50 req/s. — Hiroshi",
    labels: ["Work/Clients"],
  },
  {
    id: "atlas-hiroshi-2",
    at: "2026-10-08 07:30",
    from: HIROSHI,
    to: [ME],
    cc: [TOM],
    subject: "Atlas integration status: webhooks live in staging",
    body: "Webhooks are live in staging and the retry queue is drained. Next step is the production cutover on Oct 27. — Hiroshi",
    labels: ["Work/Clients"],
  },
  {
    id: "hiroshi-quote-ja",
    at: "2026-09-24 18:10",
    from: HIROSHI_JA,
    to: [ME],
    subject: "【お見積書】Atlas連携 追加開発のお見積り",
    body: "リベラ様\nいつもお世話になっております。Atlas連携の追加開発について、お見積書を添付いたします。ご確認のほどよろしくお願いいたします。\n田中",
    attachments: ["見積書_Atlas連携.pdf"],
    labels: ["Work/Clients"],
  },
  // Work: the NDA.
  {
    id: "nda-draft",
    at: "2026-06-10 14:00",
    from: RAVI,
    to: [ME],
    subject: "Mutual NDA for review",
    body: "Hi Alex, here's our standard mutual NDA. Redlines welcome before we sign.",
    attachments: ["Northpeak_Mutual_NDA_draft.docx"],
    labels: ["Work/Clients"],
  },
  {
    id: "nda-signed",
    at: "2026-06-17 09:20",
    from: RAVI,
    to: [ME],
    subject: "Countersigned NDA — Northpeak / Lumenworks",
    body: "Attached is the fully executed mutual NDA. Looking forward to kicking off next week.",
    attachments: ["NDA_Northpeak_Lumenworks_executed.pdf"],
    labels: ["Work/Clients"],
  },
  {
    id: "legal-nda-policy",
    at: "2026-03-03 10:00",
    from: LEGAL,
    to: [ME],
    subject: "Reminder: NDA policy for vendor conversations",
    body: "Before sharing roadmap details with a vendor, make sure an NDA is on file with legal.",
    category: "updates",
  },
  {
    id: "conf-invite",
    at: "2026-06-25 11:00",
    from: CONF,
    to: [ME],
    subject: "Invitation to speak at DevSummit West 2026",
    body: "We'd love to have you give a 30-minute session on local-first sync at DevSummit West, Nov 12–13 in Oakland. Let us know by July 15.",
  },
  {
    id: "conf-logistics",
    at: "2026-09-30 11:00",
    from: CONF,
    to: [ME],
    subject: "Speaker logistics for DevSummit West",
    body: "Your session is Nov 12 at 2:15 PM, Room B. Please upload slides by Nov 5. Speaker dinner Nov 11.",
  },
  // Home: the landlord.
  {
    id: "rent-adjustment",
    thread: "t-rent-adjustment",
    at: "2026-08-28 10:00",
    from: DIANE,
    to: [ME],
    subject: "Notice of rent adjustment effective November 1",
    body: "Dear Alex, per your lease, monthly rent for Unit 4B will change from $2,850 to $2,995 effective November 1, 2026.",
    labels: ["Home"],
  },
  {
    id: "rent-adjustment-alex",
    thread: "t-rent-adjustment",
    at: "2026-09-03 19:22",
    from: ME,
    to: [DIANE],
    subject: "Re: Notice of rent adjustment effective November 1",
    body: "Hi Diane, is the $145 increase negotiable if I sign a 2-year renewal?",
    box: "sent",
  },
  {
    id: "rent-adjustment-diane",
    thread: "t-rent-adjustment",
    at: "2026-09-05 09:15",
    from: DIANE,
    to: [ME],
    subject: "Re: Notice of rent adjustment effective November 1",
    body: "We can hold rent at $2,950 with a 24-month renewal. I'll send the updated lease next week.",
    labels: ["Home"],
  },
  {
    id: "lease-renewal",
    at: "2026-09-08 14:30",
    from: DIANE,
    to: [ME],
    subject: "Lease renewal agreement for signature — Unit 4B",
    body: "Attached is your 24-month lease renewal at $2,950/month. Please sign and return it by September 30.",
    attachments: ["Lease_Renewal_Unit4B_2026.pdf"],
    labels: ["Home"],
  },
  {
    id: "lease-reminder",
    at: "2026-09-25 09:00",
    from: DIANE,
    to: [ME],
    subject: "Reminder: lease renewal signature due Sept 30",
    body: "Just a reminder that the renewal needs your signature by the 30th. Let me know if you have questions.",
    labels: ["Home"],
  },
  {
    id: "diane-jan-smoke",
    at: "2026-01-12 10:00",
    from: DIANE,
    to: [ME],
    subject: "Annual smoke detector inspection — Jan 21",
    body: "Our technician will test smoke and CO detectors in all units on January 21 between 9 and 3.",
    labels: ["Home"],
  },
  {
    id: "diane-jan-garage",
    at: "2026-01-27 16:45",
    from: DIANE,
    to: [ME],
    subject: "Garage resurfacing this weekend",
    body: "Please move cars out of the garage by Friday 6pm. Street parking permits are at the front desk.",
    labels: ["Home"],
  },
  {
    id: "diane-feb-water",
    at: "2026-02-09 08:30",
    from: DIANE,
    to: [ME],
    subject: "Water shut-off Tuesday morning",
    body: "Water will be off from 9 to 11 on Tuesday for a valve repair.",
    labels: ["Home"],
  },
  {
    id: "dishwasher-alex",
    thread: "t-dishwasher",
    at: "2026-06-09 20:10",
    from: ME,
    to: [DIANE],
    subject: "Maintenance request: Unit 4B kitchen",
    body: "Hi Diane, the dishwasher stopped draining — there's standing water after every cycle and it smells. Could you send someone this week?",
    box: "sent",
  },
  {
    id: "dishwasher-diane",
    thread: "t-dishwasher",
    at: "2026-06-10 08:40",
    from: DIANE,
    to: [ME],
    subject: "Re: Maintenance request: Unit 4B kitchen",
    body: "A technician from Rapid Flow will come Thursday between 9 and 12 to look at it.",
    labels: ["Home"],
  },
  {
    id: "plumber-estimate",
    at: "2026-03-10 13:05",
    from: PLUMBER,
    to: [ME],
    subject: "Estimate #2231 — water heater replacement",
    body: "Thanks for having us out. Our estimate for replacing the 50-gallon water heater is $1,450 including haul-away. Valid for 30 days.",
    attachments: ["estimate-2231.pdf"],
  },
  // Home: the kitchen remodel.
  {
    id: "kitchen-proposal",
    at: "2026-05-12 17:00",
    from: BEN,
    to: [ME],
    subject: "Kitchen remodel proposal",
    body: "Hi Alex, attached is the proposal for the kitchen remodel: cabinets, quartz counters and new lighting. Six weeks start to finish.",
    attachments: ["Rivera-kitchen-proposal.pdf"],
    starred: true,
    labels: ["Home"],
  },
  {
    id: "kitchen-cabinets",
    at: "2026-06-02 12:30",
    from: BEN,
    to: [ME],
    subject: "Cabinet order confirmed + revised timeline",
    body: "Cabinets are ordered and arrive June 16. Demo starts June 15, so the kitchen will be out of service for about five weeks.",
    starred: true,
    labels: ["Home"],
  },
  {
    id: "kitchen-week2",
    at: "2026-06-29 18:00",
    from: BEN,
    to: [ME],
    subject: "Week 2 update: countertops",
    body: "Countertop templating is done; install is next Wednesday. Photos attached.",
    attachments: ["counters-1.jpg"],
    labels: ["Home"],
  },
  // Family and friends.
  {
    id: "mom-lake-1",
    at: "2026-07-06 21:14",
    from: MOM,
    to: [ME],
    subject: "Tahoe weekend pictures!",
    body: "Here are the pictures from the lake weekend. Look at Leo on the paddleboard!",
    attachments: ["IMG_2201.jpg", "IMG_2207.jpg", "IMG_2215.jpg"],
  },
  {
    id: "mom-lake-2",
    at: "2026-07-07 08:03",
    from: MOM,
    to: [ME],
    subject: "more from the lake",
    body: "A few more — the sunset one is my favorite. Love, Mom",
    attachments: ["IMG_2230.jpg", "IMG_2231.jpg"],
  },
  {
    id: "mom-dad-birthday",
    at: "2026-03-15 19:40",
    from: MOM,
    to: [ME],
    subject: "Photos from Dad's birthday",
    body: "The cake photos turned out great. Dad loved the watch.",
    attachments: ["cake.jpg", "dad.jpg"],
  },
  {
    id: "mom-thanksgiving",
    at: "2025-11-10 12:00",
    from: MOM,
    to: [ME],
    subject: "Thanksgiving plans",
    body: "Are you driving up Wednesday or Thursday? I'm making the stuffing you like.",
  },
  {
    id: "carlos-valencia",
    at: "2026-08-04 22:10",
    from: CARLOS,
    to: [ME],
    subject: "¿Nos vemos en Valencia?",
    body: "¡Hola Alex! Si vienes a Europa este verano, avísame y cenamos en Valencia.",
  },
  {
    id: "carlos-contract",
    at: "2026-09-16 10:25",
    from: CARLOS,
    to: [ME],
    subject: "Contrato de prestación de servicios — versión final",
    body: "Hola Alex, te mando el contrato con los cambios que hablamos. Si estás de acuerdo, fírmalo y me lo devuelves esta semana. Un abrazo, Carlos",
    attachments: ["Contrato_servicios_Rivera_Mendoza.pdf"],
  },
  {
    id: "carlos-invoice",
    at: "2026-10-02 09:00",
    from: CARLOS,
    to: [ME],
    subject: "Factura de septiembre",
    body: "Te adjunto la factura de septiembre por las horas de traducción. Gracias.",
    attachments: ["Factura_2026-09.pdf"],
  },
  {
    id: "maya-party",
    thread: "t-maya-party",
    at: "2026-10-06 19:30",
    from: LENA,
    to: [ME],
    subject: "Maya's 7th birthday party!",
    body: "Maya is turning 7 and we'd love for Leo to come! Saturday, October 24, 3:00–5:00 PM at the Sunnyside Park pavilion. RSVP by the 18th.",
  },
  {
    id: "maya-party-rsvp",
    thread: "t-maya-party",
    at: "2026-10-07 07:50",
    from: ME,
    to: [LENA],
    subject: "Re: Maya's 7th birthday party!",
    body: "Leo would love to come — see you there!",
    box: "sent",
  },
  {
    id: "recipe-marco",
    at: "2026-02-22 18:30",
    from: MARCO,
    to: [ME],
    subject: "that chicken recipe",
    body: "As promised! Roast the chicken with lemon, garlic and oregano at 425F for 50 minutes, then rest 10. Potatoes go in the same pan.",
  },
  {
    id: "bike-buyer",
    thread: "t-bike",
    at: "2026-05-18 12:40",
    from: BUYER,
    to: [ME],
    subject: "Is the bicycle still available?",
    body: "Hi, I saw your listing for the blue road bicycle. I'd like to buy it — could I come see it Saturday? I can pay $400 cash.",
  },
  {
    id: "bike-reply",
    thread: "t-bike",
    at: "2026-05-18 15:05",
    from: ME,
    to: [BUYER],
    subject: "Re: Is the bicycle still available?",
    body: "Yes, still available. Saturday at 11 works.",
    box: "sent",
  },
  // Kids' school.
  {
    id: "school-welcome",
    at: "2026-09-03 07:30",
    from: SCHOOL,
    to: [ME],
    subject: "Welcome back to Maple Grove!",
    body: "Welcome to the new school year. Drop-off starts at 7:45.",
  },
  {
    id: "school-picture-day",
    at: "2026-10-15 07:30",
    from: SCHOOL,
    to: [ME],
    subject: "Picture day is Thursday, Oct 22",
    body: "Order forms went home in backpacks. Retakes are in November.",
    read: false,
  },
  {
    id: "school-field-trip",
    at: "2026-10-17 07:30",
    from: SCHOOL,
    to: [ME],
    subject: "Field trip permission slip due",
    body: "Second grade visits the science museum on Oct 30. Please sign the permission slip by Oct 23.",
    read: false,
  },
  // Health.
  {
    id: "dentist-april",
    at: "2026-03-30 09:00",
    from: DENTAL,
    to: [ME],
    subject: "Appointment confirmed: Tue, April 14 at 9:00 AM",
    body: "Your cleaning with Dr. Huang is confirmed for Tuesday, April 14 at 9:00 AM.",
  },
  {
    id: "dentist-november",
    at: "2026-10-09 09:00",
    from: DENTAL,
    to: [ME],
    subject: "Appointment confirmed: Thu, November 5 at 2:30 PM",
    body: "Your cleaning with Dr. Huang is confirmed for Thursday, November 5 at 2:30 PM. Reply C to confirm or call to reschedule.",
  },
  {
    id: "dentist-promo",
    at: "2026-10-16 10:00",
    from: DENTAL,
    to: [ME],
    subject: "Whitening special this month",
    body: "Brighten your smile — 20% off whitening through October.",
    category: "promotions",
    read: false,
  },
  // Money.
  {
    id: "mortgage-preapproval",
    at: "2026-05-20 10:00",
    from: BANK,
    to: [ME],
    subject: "Your mortgage pre-approval letter",
    body: "Congratulations — you're pre-approved for a home loan of up to $720,000. Your letter is attached and valid for 90 days.",
    attachments: ["preapproval-letter.pdf"],
  },
  {
    id: "mortgage-conditional",
    at: "2026-10-07 15:00",
    from: BANK,
    to: [ME],
    subject: "Loan update: conditional approval",
    body: "Good news: your loan application has received conditional approval. Remaining conditions: an updated pay stub and the signed purchase agreement.",
  },
  {
    id: "tax-w2",
    at: "2026-01-28 06:00",
    from: PAYROLL,
    to: [ME],
    subject: "Your 2025 W-2 is available",
    body: "Your 2025 Form W-2 is ready to download in the payroll portal.",
    labels: ["Taxes"],
  },
  {
    id: "tax-documents-needed",
    at: "2026-02-12 11:00",
    from: CPA,
    to: [ME],
    subject: "Documents needed for your 2025 return",
    body: "Hi Alex, please upload your W-2, 1099-INT from Harborview, and charitable receipts by March 1.",
    labels: ["Taxes"],
  },
  {
    id: "tax-return-ready",
    at: "2026-03-30 16:00",
    from: CPA,
    to: [ME],
    subject: "Your 2025 return is ready to sign",
    body: "Your federal and state returns are attached. Sign form 8879 and I'll e-file this week.",
    attachments: ["Rivera_2025_returns.pdf"],
    labels: ["Taxes"],
  },
  {
    id: "tax-estimated-q4",
    at: "2025-12-29 09:00",
    from: CPA,
    to: [ME],
    subject: "Reminder: Q4 estimated payment due Jan 15",
    body: "If you had freelance income this year, your Q4 estimated payment is due January 15.",
    labels: ["Taxes"],
  },
  // Travel.
  {
    id: "flight-chicago",
    at: "2025-12-01 13:00",
    from: SKYLINE,
    to: [ME],
    subject: "Your Skyline Air confirmation — SFO to ORD, Dec 20",
    body: "Confirmation code: KX7P2M. Passenger: Alex Rivera. Depart San Francisco (SFO) Dec 20, 7:05 AM, arrive Chicago O'Hare 1:25 PM.",
    labels: ["Travel"],
  },
  {
    id: "boarding-chicago",
    at: "2025-12-20 04:30",
    from: SKYLINE,
    to: [ME],
    subject: "Your boarding pass — SFO to ORD",
    body: "You're checked in. Gate closes 15 minutes before departure. Boarding pass attached.",
    attachments: ["boarding-pass-KX7P2M.pdf"],
    labels: ["Travel"],
  },
  {
    id: "flight-promo-spring",
    at: "2026-03-20 08:00",
    from: SKYLINE_DEALS,
    to: [ME],
    subject: "Spring fares from $89 — book by Sunday",
    body: "Fly anywhere we go this spring from $89 one way. Book by Sunday.",
    category: "promotions",
  },
  {
    id: "flight-denver",
    at: "2026-04-09 18:22",
    from: SKYLINE,
    to: [ME],
    subject: "Your Skyline Air confirmation — SFO to DEN, Apr 24",
    body: "Confirmation code: Q4ZT8R. Passenger: Alex Rivera. Depart San Francisco (SFO) Apr 24, 8:40 AM, arrive Denver 12:10 PM. Return Apr 27.",
    labels: ["Travel"],
  },
  {
    id: "hotel-denver",
    at: "2026-04-10 09:12",
    from: HOTEL_DENVER,
    to: [ME],
    subject: "Your reservation at Mile High Suites",
    body: "Reservation #MH-30917, Apr 24–27, one king room. Check-in from 3 PM.",
    labels: ["Travel"],
  },
  {
    id: "boarding-denver",
    at: "2026-04-24 05:10",
    from: SKYLINE,
    to: [ME],
    subject: "Your boarding pass — SFO to DEN",
    body: "You're checked in. Gate closes 15 minutes before departure. Boarding pass attached.",
    attachments: ["boarding-pass-Q4ZT8R.pdf"],
    labels: ["Travel"],
  },
  {
    id: "spam-flight-refund",
    at: "2026-05-02 03:12",
    from: REFUND_SPAM,
    to: [ME],
    subject: "Flight confirmation required — claim your refund",
    body: "Your flight refund is pending. Confirm your card details to receive $412.",
    box: "spam",
  },
  {
    id: "flight-lisbon",
    at: "2026-07-02 20:45",
    from: SKYLINE,
    to: [ME],
    subject: "Your Skyline Air confirmation — SFO to LIS, Aug 14",
    body: "Confirmation code: LM3V9D. Passenger: Alex Rivera. Depart San Francisco (SFO) Aug 14, 3:50 PM, arrive Lisbon (LIS) Aug 15, 11:30 AM. Return Aug 22.",
    labels: ["Travel"],
  },
  {
    id: "hotel-lisbon",
    at: "2026-07-03 10:05",
    from: HOTEL_LISBON,
    to: [ME],
    subject: "Booking confirmed: Casa Alfama Hotel, Aug 15–22",
    body: "Thank you for booking Casa Alfama Hotel in Lisbon. Confirmation number: CA-55821. Seven nights, double room with breakfast.",
    labels: ["Travel"],
  },
  {
    id: "cabin-checkin",
    at: "2026-07-28 16:00",
    from: CABIN,
    to: [ME],
    subject: "Check-in details for your stay at Pine Hollow (Aug 1–3)",
    body: "The lockbox code is 4471. Wi-Fi network: PineHollow-Guest, password: cedar-smoke-22. Firewood is by the back porch.",
    labels: ["Travel"],
  },
  {
    id: "hotel-lisbon-reminder",
    at: "2026-08-10 09:00",
    from: HOTEL_LISBON,
    to: [ME],
    subject: "Your stay is coming up",
    body: "We look forward to welcoming you on August 15. Airport transfers can be booked at reception.",
    labels: ["Travel"],
  },
  {
    id: "boarding-lisbon",
    at: "2026-08-14 11:00",
    from: SKYLINE,
    to: [ME],
    subject: "Your boarding pass — SFO to LIS",
    body: "You're checked in. Gate closes 15 minutes before departure. Boarding pass attached.",
    attachments: ["boarding-pass-LM3V9D.pdf"],
    labels: ["Travel"],
  },
  // Car.
  {
    id: "registration-notice",
    at: "2026-08-30 06:00",
    from: MOTOR,
    to: [ME],
    subject: "Your vehicle registration expires October 31",
    body: "Renew online by October 31 to avoid late fees. Plate ending 123. Smog certification is on file.",
  },
  {
    id: "registration-reminder",
    at: "2026-10-05 06:00",
    from: MOTOR,
    to: [ME],
    subject: "Reminder: registration renewal due",
    body: "Your vehicle registration renewal is due October 31. Renew online in about five minutes.",
    read: false,
  },
  // Shopping.
  {
    id: "order-bike-lights",
    at: "2026-03-04 12:00",
    from: PARCELLY,
    to: [ME],
    subject: "Order confirmed: Bike light set",
    body: "Order #PC-31877. USB rechargeable bike light set, $34.99. Receipt attached to your account.",
    labels: ["Receipts"],
    category: "updates",
  },
  {
    id: "order-tent",
    at: "2026-08-03 21:10",
    from: PARCELLY,
    to: [ME],
    subject: "Order confirmed: 4-person camping tent",
    body: "Order #PC-44102. 4-person camping tent, $189.00. Estimated delivery Aug 7.",
    labels: ["Receipts"],
    category: "updates",
  },
  {
    id: "order-tent-shipped",
    at: "2026-08-05 08:00",
    from: PARCELLY,
    to: [ME],
    subject: "Shipped: 4-person camping tent",
    body: "Your order #PC-44102 is on its way. Tracking number PX99012233.",
    category: "updates",
  },
  {
    id: "order-backpack",
    at: "2026-08-19 13:30",
    from: PARCELLY,
    to: [ME],
    subject: "Order confirmed: Kids' backpack (blue)",
    body: "Order #PC-45590. Kids' backpack, blue, $42.50. Estimated delivery Aug 22.",
    labels: ["Receipts"],
    category: "updates",
  },
  {
    id: "package-exception",
    at: "2026-09-12 10:20",
    from: PARCELLY,
    to: [ME],
    subject: "Update on your order #PC-48213: delivery exception",
    body: "Your package was marked as delivered, but our carrier couldn't confirm the drop-off. If you haven't received it, reply and we'll send a replacement or a refund.",
    category: "updates",
  },
  {
    id: "package-replacement",
    at: "2026-09-14 09:45",
    from: PARCELLY,
    to: [ME],
    subject: "Your replacement is on the way",
    body: "We've shipped a replacement for order #PC-48213 at no charge. Tracking number PX99877120.",
    category: "updates",
  },
  {
    id: "order-grinder",
    at: "2026-10-02 19:15",
    from: PARCELLY,
    to: [ME],
    subject: "Order confirmed: Burr coffee grinder",
    body: "Order #PC-50311. Burr coffee grinder, $129.00. Your receipt is below.",
    labels: ["Receipts"],
    category: "updates",
  },
  {
    id: "coffee-october",
    at: "2026-10-06 05:00",
    from: COFFEE,
    to: [ME],
    subject: "Receipt for your October subscription",
    body: "Thanks! Your October bag (Ethiopia Guji, 12 oz) ships today. Charged $18.00 to your card ending 4417.",
    labels: ["Receipts"],
  },
  {
    id: "order-headphones",
    at: "2026-10-11 22:40",
    from: PARCELLY,
    to: [ME],
    subject: "Order confirmed: Wireless noise-cancelling headphones",
    body: "Order #PC-51068. Wireless noise-cancelling headphones, $249.00. Estimated delivery Oct 15.",
    labels: ["Receipts"],
    category: "updates",
  },
  {
    id: "order-headphones-shipped",
    at: "2026-10-13 07:10",
    from: PARCELLY,
    to: [ME],
    subject: "Shipped: Wireless noise-cancelling headphones",
    body: "Your order #PC-51068 is on its way. Tracking number PX10022231.",
    category: "updates",
    read: false,
  },
];

const MORNING_BYTE_TOPICS = [
  "How to plan a team offsite people actually enjoy",
  "Airlines quietly change flight change fees",
  "In defense of the humble spreadsheet",
  "Mortgage rates dip for a third week",
  "Why your electricity bill spiked this summer",
  "The best noise-cancelling headphones under $300",
  "Dentists on the coffee-and-teeth question",
  "Remote work and the return of the budget meeting",
  "What a lost package costs retailers",
  "Wi-Fi 7 routers, tested",
  "The case against weekly status emails",
  "Five boarding pass tricks frequent flyers use",
  "Spring travel: where fares are falling",
  "Is your landlord allowed to raise the rent mid-lease?",
  "Kitchen remodels that pay for themselves",
  "The quiet return of the conference talk",
  "Why invoices still arrive as PDFs",
  "Bike commuting, one year in",
  "Our favorite lemon chicken, adapted",
  "Tax season prep checklist",
  "How to read a lease before you sign it",
  "The economics of hotel loyalty",
  "Japanese stationery and the art of the quote",
  "School pictures: still worth it?",
  "Registration renewals go fully online",
];

const RUNNER_TOPICS = [
  "Thanksgiving turkey trot meetup",
  "December long run + cocoa",
  "New year, new route: Ocean Beach loop",
  "Track Tuesdays are back",
  "Spring half marathon training plan",
  "Trail cleanup day",
  "Race recap: Bay to Breakers",
  "Summer early-morning runs",
  "Hydration and heat tips",
  "Club picnic at the lake",
  "Fall trail series registration",
  "Halloween costume fun run",
];

const KITCHEN_TOPICS = [
  "Five weeknight chicken dinners",
  "Lemon everything: our citrus issue",
  "Sheet-pan suppers for busy families",
  "Soup season starts now",
  "Grilling without the stress",
  "Make-ahead school lunches",
  "One-pot pasta, five ways",
  "Weeknight fish that kids eat",
];

const DEALS = [
  "Up to 40% off outdoor gear",
  "Headphones flash sale ends tonight",
  "Back-to-school deals on backpacks",
  "Kitchen week: grinders, kettles and more",
  "Save on dishwasher pods and cleaning supplies",
  "Bike accessories from $9.99",
  "Your cart misses you",
  "Early holiday deals are here",
  "Camping essentials for the long weekend",
  "Members save an extra 10% this weekend",
];

const CODEFORGE_EVENTS = [
  "[lumenworks/atlas] PR #412: Add webhook retry queue",
  "[lumenworks/atlas] PR #418: Integration sandbox config",
  "[lumenworks/atlas] Issue #233: Atlas importer times out on large files",
  "[lumenworks/platform] PR #1201: Bump observability agent",
  "[lumenworks/atlas] PR #427: Staging cutover runbook",
  "[lumenworks/platform] Build failed on main",
  "[lumenworks/atlas] PR #431: Rollback drill script",
  "[lumenworks/platform] PR #1219: Budget alerts for staging",
  "[lumenworks/atlas] Issue #241: Webhook signatures mismatch",
  "[lumenworks/platform] PR #1225: On-call rotation bot",
  "[lumenworks/atlas] PR #439: Integration status page",
  "[lumenworks/platform] Security advisory for a dependency",
  "[lumenworks/atlas] PR #444: Production cutover checklist",
  "[lumenworks/platform] PR #1230: Capacity dashboard",
  "[lumenworks/atlas] Issue #250: Sandbox API keys rotate weekly",
];

/** Recurring mail that fills out the months around the hand-written mail. */
function generatedMail(): FixtureEmail[] {
  const mail: FixtureEmail[] = [];
  const months = monthsFrom(2025, 11, 12);

  for (const [index, { year, month }] of months.entries()) {
    const monthName = monthLabel(year, month);
    const amount = (84 + ((index * 37) % 61)).toFixed(2);
    mail.push({
      id: `bill-${year}-${pad(month)}`,
      at: `${year}-${pad(month)}-0${3 + (index % 3)} 06:30`,
      from: BAYLINE,
      to: [ME],
      subject: `Your Bayline Energy bill for ${monthName} is ready`,
      body: `Your electric service bill is ready. Amount due: $${amount}. Due date: the 25th. Usage this period: ${310 + index * 14} kWh. Autopay is on.`,
      category: "updates",
      read: index < 11,
    });
    mail.push({
      id: `rent-receipt-${year}-${pad(month)}`,
      at: `${year}-${pad(month)}-01 08:00`,
      from: GREENLEAF,
      to: [ME],
      subject: `Payment received — thank you (${monthName})`,
      body: `We received your rent payment of $2,850.00 for Unit 4B for ${monthName}. Receipt #GL-${year}${pad(month)}-4B.`,
      labels: ["Home"],
      category: "updates",
    });
    mail.push({
      id: `bank-statement-${year}-${pad(month)}`,
      at: `${year}-${pad(month)}-0${2 + (index % 4)} 05:00`,
      from: BANK,
      to: [ME],
      subject: `Your ${monthName} statement is ready`,
      body: "Your checking and savings statements are ready in online banking.",
      category: "updates",
    });
    mail.push({
      id: `runners-${year}-${pad(month)}`,
      at: `${year}-${pad(month)}-1${index % 9} 07:00`,
      from: RUNNERS,
      to: [ME],
      subject: `Trailhead Runners: ${RUNNER_TOPICS[index]}`,
      body: `This month at the club: ${RUNNER_TOPICS[index].toLowerCase()}. Saturday group run meets at 8am at the usual trailhead.`,
      category: "social",
    });
  }

  // The Morning Byte: every other Tuesday.
  const firstIssue = new TZDate(2025, 10, 4, 6, 0, TIMEZONE);
  for (const [index, topic] of MORNING_BYTE_TOPICS.entries()) {
    const day = new TZDate(
      firstIssue.getTime() + index * 14 * DAY_MS,
      TIMEZONE,
    );
    mail.push({
      id: `morning-byte-${index + 1}`,
      at: localStamp(day),
      from: MORNING_BYTE,
      to: [ME],
      subject: `The Morning Byte #${120 + index}: ${topic}`,
      body: `Today's lead: ${topic}. Plus: three links worth your time and a reader question. Unsubscribe anytime.`,
      category: "promotions",
      read: index < MORNING_BYTE_TOPICS.length - 2,
    });
  }

  for (const [index, topic] of KITCHEN_TOPICS.entries()) {
    mail.push({
      id: `weeknight-kitchen-${index + 1}`,
      at: `2026-${pad(2 + index)}-2${index % 8} 16:00`,
      from: KITCHEN_NEWS,
      to: [ME],
      subject: `Weeknight Kitchen: ${topic}`,
      body: `This week: ${topic.toLowerCase()}. Every recipe takes 40 minutes or less.`,
      category: "promotions",
    });
  }

  for (const [index, deal] of DEALS.entries()) {
    mail.push({
      id: `parcelly-deal-${index + 1}`,
      at: `2026-${pad(1 + index)}-1${(index * 3) % 10} 09:00`,
      from: PARCELLY_DEALS,
      to: [ME],
      subject: deal,
      body: `${deal}. Shop now on Parcelly — free shipping over $35.`,
      category: "promotions",
    });
  }

  for (const [index, event] of CODEFORGE_EVENTS.entries()) {
    const day = new TZDate(2026, 7, 3 + index * 5, 11, 0, TIMEZONE);
    mail.push({
      id: `codeforge-${index + 1}`,
      at: localStamp(day),
      from: CODEFORGE,
      to: [ME],
      subject: event,
      body: `${event}\n\nView it on CodeForge. You're receiving this because you're watching this repository.`,
      category: "updates",
    });
  }

  return mail;
}

export const FIXTURE_EMAILS: FixtureEmail[] = [
  ...HAND_WRITTEN,
  ...generatedMail(),
];

/** Each message's conversation. */
export function conversationOf(email: FixtureEmail) {
  return email.thread ?? email.id;
}

/**
 * The fixture in a real SQLite mail store, the one the browser runs, with
 * every body indexed for search. No provider is attached: a search reads only
 * what the store answers itself.
 */
export async function openFixtureMailbox(): Promise<{
  store: MailStore;
  close: () => Promise<void>;
}> {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: ACCOUNT_ID,
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "search-retrieval-eval",
    page: {
      session: { accountId: ACCOUNT_ID, generation: "g1" },
      requestId: "bootstrap",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: FIXTURE_EMAILS.map(messagePatch),
      requiredHydration: [],
      roundComplete: true,
    },
    bodies: FIXTURE_EMAILS.map((email) => ({
      key: { accountId: ACCOUNT_ID, messageId: email.id },
      version: "1",
      text: email.body,
      html: null,
    })),
  });
  while ((await store.indexSearchBacklog()).remaining) {
    // Index every body before the first search.
  }
  return { store, close: () => store.close() };
}

function messagePatch(
  email: FixtureEmail,
): Extract<ProviderChange, { kind: "message_patch" }> {
  const box = email.box ?? "inbox";
  const systemLabels = {
    inbox: ["INBOX"],
    archive: [],
    sent: ["SENT"],
    spam: ["SPAM"],
  }[box];
  const roles = {
    inbox: ["inbox" as const],
    archive: [],
    sent: ["sent" as const],
    spam: ["spam" as const],
  }[box];
  const categoryIds = email.category
    ? [`CATEGORY_${email.category.toUpperCase()}`]
    : [];
  const labelIds = [
    ...systemLabels,
    ...(email.starred ? ["STARRED"] : []),
    ...categoryIds,
    ...(email.labels ?? []).map(
      (name) => LABELS.find((label) => label.name === name)!.id,
    ),
  ];
  return {
    kind: "message_patch",
    key: { accountId: ACCOUNT_ID, messageId: email.id },
    reference: {
      provider: "google",
      messageId: email.id,
      conversationId: conversationOf(email),
      version: "1",
    },
    fields: {
      subject: email.subject,
      preview: email.body.slice(0, 160),
      from: email.from,
      to: email.to ?? [ME],
      cc: email.cc ?? [],
      receivedAtMs: localMs(email.at),
      read: email.read ?? true,
      starred: Boolean(email.starred),
      folderId: null,
      labelIds,
      categoryIds,
      roles,
      hasAttachments: Boolean(email.attachments?.length),
    },
  };
}

function localMs(stamp: string) {
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Bad fixture time: ${stamp}`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  return new TZDate(year, month - 1, day, hour, minute, TIMEZONE).getTime();
}

function localStamp(date: TZDate) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function monthsFrom(year: number, month: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const zeroBased = month - 1 + offset;
    return {
      year: year + Math.floor(zeroBased / 12),
      month: (zeroBased % 12) + 1,
    };
  });
}

function monthLabel(year: number, month: number) {
  return new TZDate(year, month - 1, 15, TIMEZONE).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: TIMEZONE,
  });
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
