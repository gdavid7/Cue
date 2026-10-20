/**
 * What a person types into the search bar of the mailbox in
 * search-retrieval-mailbox.ts, and the mail they want back. Today is Monday,
 * October 19, 2026 in America/Los_Angeles.
 */

export type RetrievalQueryType =
  | "people"
  | "time"
  | "attribute"
  | "vague"
  | "question"
  | "multilingual";

export type RetrievalQuery = {
  id: string;
  type: RetrievalQueryType;
  /** What the user types, as typed. */
  query: string;
  /** The mail the user is after, in words, for the judge and the report. */
  intent: string;
  /** Message ids of the mail that answers the query. */
  relevant: string[];
  /**
   * Where other mail can reasonably satisfy the query too. The judge then
   * grades the results outside `relevant`, for precision and rank only;
   * recall stays measured against `relevant`.
   */
  fuzzy?: boolean;
  /**
   * The keyword search a practiced Gmail user would type instead, in Gmail
   * syntax: a stronger baseline than the sentence typed as keywords.
   */
  keywords: string;
};

export const RETRIEVAL_QUERIES: RetrievalQuery[] = [
  // People.
  {
    id: "people-sarah-offsite",
    type: "people",
    query: "what did Sarah say about the offsite",
    intent:
      "Sarah Kim's emails about the team offsite (dates, agenda, venue change)",
    relevant: ["offsite-sarah-1", "offsite-sarah-2", "offsite-sarah-3"],
    keywords: "from:sarah offsite",
  },
  {
    id: "people-priya-q3",
    type: "people",
    query: "emails from Priya about the Q3 budget",
    intent: "Priya's emails about Q3 budget planning and decisions",
    relevant: ["budget-q3-priya-1", "budget-q3-priya-2"],
    keywords: "from:priya Q3 budget",
  },
  {
    id: "people-sent-tom",
    type: "people",
    query: "emails I sent to Tom last week",
    intent:
      "Mail the user sent to Tom between Monday Oct 12 and Sunday Oct 18, 2026",
    relevant: ["sent-tom-1", "sent-tom-2"],
    keywords: "in:sent to:tom after:2026/10/12 before:2026/10/19",
  },
  {
    id: "people-landlord-rent",
    type: "people",
    query: "anything from my landlord about the rent going up",
    intent:
      "The landlord's notice that rent changes from $2,850 to $2,995, and the thread about it",
    relevant: ["rent-adjustment", "rent-adjustment-diane"],
    keywords: "rent increase",
  },
  {
    id: "people-mom-lake",
    type: "people",
    query: "photos my mom sent from the lake trip",
    intent: "Mom's emails with pictures from the July lake weekend",
    relevant: ["mom-lake-1", "mom-lake-2"],
    keywords: "from:elena lake",
  },
  {
    id: "people-hiroshi-atlas",
    type: "people",
    query: "Hiroshi's latest update on the Atlas integration",
    intent:
      "Hiroshi's most recent status email on the Atlas integration (webhooks live in staging)",
    relevant: ["atlas-hiroshi-2"],
    fuzzy: true,
    keywords: "from:hiroshi atlas",
  },
  // Time.
  {
    id: "time-flight-spring",
    type: "time",
    query: "flight confirmation from last spring",
    intent: "The airline booking confirmation that arrived in spring 2026",
    relevant: ["flight-denver"],
    fuzzy: true,
    keywords: "flight confirmation after:2026/03/01 before:2026/06/01",
  },
  {
    id: "time-electric-last-month",
    type: "time",
    query: "electricity bill from last month",
    intent: "The electric utility bill that arrived in September 2026",
    relevant: ["bill-2026-09"],
    keywords: "electric bill after:2026/09/01 before:2026/10/01",
  },
  {
    id: "time-receipts-this-month",
    type: "time",
    query: "receipts from this month",
    intent:
      "Purchase receipts and payment confirmations received in October 2026",
    relevant: [
      "order-grinder",
      "coffee-october",
      "order-headphones",
      "rent-receipt-2026-10",
    ],
    fuzzy: true,
    keywords: "receipt after:2026/10/01",
  },
  {
    id: "time-orders-august",
    type: "time",
    query: "what did I order in August",
    intent: "Order confirmations received in August 2026",
    relevant: ["order-tent", "order-backpack"],
    fuzzy: true,
    keywords: "order after:2026/08/01 before:2026/09/01",
  },
  {
    id: "time-hotel-july",
    type: "time",
    query: "hotel reservation I got in July",
    intent: "The hotel booking confirmation received in July 2026",
    relevant: ["hotel-lisbon"],
    keywords: "hotel after:2026/07/01 before:2026/08/01",
  },
  {
    id: "time-diane-january",
    type: "time",
    query: "emails from Diane in January",
    intent: "Diane's emails received in January 2026",
    relevant: ["diane-jan-smoke", "diane-jan-garage"],
    keywords: "from:diane after:2026/01/01 before:2026/02/01",
  },
  {
    id: "time-tax-docs",
    type: "time",
    query: "tax documents from earlier this year",
    intent:
      "2026 mail about the user's tax return: the W-2, the accountant's document request and the return to sign",
    relevant: ["tax-w2", "tax-documents-needed", "tax-return-ready"],
    fuzzy: true,
    keywords: "tax after:2026/01/01",
  },
  // Attributes.
  {
    id: "attr-landlord-pdf",
    type: "attribute",
    query: "the PDF contract from the landlord",
    intent: "The lease renewal agreement the landlord sent as a PDF",
    relevant: ["lease-renewal"],
    keywords: "lease has:attachment",
  },
  {
    id: "attr-signed-nda",
    type: "attribute",
    query: "the signed NDA",
    intent: "The fully executed (countersigned) NDA from Northpeak",
    relevant: ["nda-signed"],
    keywords: "nda signed",
  },
  {
    id: "attr-tom-spreadsheets",
    type: "attribute",
    query: "spreadsheets Tom sent me",
    intent: "Tom's emails with spreadsheet attachments",
    relevant: ["tom-sheet-capacity", "tom-sheet-vendors"],
    keywords: "from:tom has:attachment",
  },
  {
    id: "attr-starred-kitchen",
    type: "attribute",
    query: "starred emails about the kitchen renovation",
    intent: "The starred emails from the kitchen remodel contractor",
    relevant: ["kitchen-proposal", "kitchen-cabinets"],
    keywords: "is:starred kitchen",
  },
  {
    id: "attr-boarding-passes",
    type: "attribute",
    query: "all my boarding passes",
    intent: "Every boarding pass email",
    relevant: ["boarding-chicago", "boarding-denver", "boarding-lisbon"],
    keywords: "boarding pass",
  },
  {
    id: "attr-unread-school",
    type: "attribute",
    query: "unread emails from the school",
    intent: "The school's emails the user hasn't read",
    relevant: ["school-picture-day", "school-field-trip"],
    keywords: "is:unread maple grove",
  },
  {
    id: "attr-taxes-label",
    type: "attribute",
    query: "everything in my Taxes label",
    intent: "Every email labelled Taxes",
    relevant: [
      "tax-w2",
      "tax-documents-needed",
      "tax-return-ready",
      "tax-estimated-q4",
    ],
    keywords: "label:taxes",
  },
  // Vague recall.
  {
    id: "vague-dishwasher",
    type: "vague",
    query: "that email about the broken dishwasher",
    intent: "The maintenance thread about the dishwasher that stopped draining",
    relevant: ["dishwasher-alex", "dishwasher-diane"],
    keywords: "dishwasher",
  },
  {
    id: "vague-car-registration",
    type: "vague",
    query: "the thing about renewing my car registration",
    intent: "The vehicle registration renewal notices",
    relevant: ["registration-notice", "registration-reminder"],
    keywords: "registration",
  },
  {
    id: "vague-bike-buyer",
    type: "vague",
    query: "the guy who wanted to buy my bike",
    intent: "The buyer asking whether the listed bicycle is still available",
    relevant: ["bike-buyer"],
    keywords: "bike",
  },
  {
    id: "vague-lemon-chicken",
    type: "vague",
    query: "that lemon chicken recipe someone sent me",
    intent: "Marco's email with the lemon roast chicken recipe",
    relevant: ["recipe-marco"],
    keywords: "lemon chicken",
  },
  {
    id: "vague-plumber-quote",
    type: "vague",
    query: "the plumber's quote",
    intent: "The plumbing company's estimate for replacing the water heater",
    relevant: ["plumber-estimate"],
    keywords: "plumber quote",
  },
  {
    id: "vague-lost-package",
    type: "vague",
    query: "something about a package that got lost",
    intent:
      "The store's notice that a delivery couldn't be confirmed, and the replacement",
    relevant: ["package-exception", "package-replacement"],
    fuzzy: true,
    keywords: "package lost",
  },
  {
    id: "vague-conference-talk",
    type: "vague",
    query: "the conference where they invited me to give a talk",
    intent: "The invitation to speak at DevSummit West, and its logistics",
    relevant: ["conf-invite", "conf-logistics"],
    fuzzy: true,
    keywords: "conference talk invite",
  },
  // Questions.
  {
    id: "question-dentist",
    type: "question",
    query: "when is my dentist appointment?",
    intent:
      "The confirmation for the upcoming dental appointment (Thursday, November 5, 2:30 PM)",
    relevant: ["dentist-november"],
    fuzzy: true,
    keywords: "dentist appointment",
  },
  {
    id: "question-cabin-wifi",
    type: "question",
    query: "what's the wifi password at the cabin?",
    intent: "The cabin host's check-in email with the Wi-Fi password",
    relevant: ["cabin-checkin"],
    keywords: "wifi password",
  },
  {
    id: "question-last-electric-bill",
    type: "question",
    query: "how much was my last electricity bill?",
    intent: "The most recent electric bill (October 2026)",
    relevant: ["bill-2026-10"],
    keywords: "electric bill",
  },
  {
    id: "question-mortgage",
    type: "question",
    query: "did the bank approve my mortgage?",
    intent:
      "The bank's conditional approval of the loan, and the earlier pre-approval",
    relevant: ["mortgage-conditional", "mortgage-preapproval"],
    fuzzy: true,
    keywords: "mortgage approval",
  },
  {
    id: "question-maya-party",
    type: "question",
    query: "what time does Maya's birthday party start?",
    intent: "The invitation to Maya's 7th birthday party",
    relevant: ["maya-party", "maya-party-rsvp"],
    keywords: "maya birthday",
  },
  {
    id: "question-lisbon-hotel-number",
    type: "question",
    query: "what's my confirmation number for the Lisbon hotel?",
    intent: "The Lisbon hotel booking confirmation (number CA-55821)",
    relevant: ["hotel-lisbon"],
    fuzzy: true,
    keywords: "lisbon hotel confirmation",
  },
  // Other languages.
  {
    id: "multi-es-carlos-contract",
    type: "multilingual",
    query: "el contrato que me mandó Carlos en septiembre",
    intent: "Carlos's September email with the services contract (in Spanish)",
    relevant: ["carlos-contract"],
    keywords: "from:carlos contrato",
  },
  {
    id: "multi-fr-lisbon-flight",
    type: "multilingual",
    query: "quand est mon vol pour Lisbonne ?",
    intent:
      "The Lisbon flight confirmation (in English), which holds the flight date",
    relevant: ["flight-lisbon"],
    fuzzy: true,
    keywords: "vol Lisbonne",
  },
  {
    id: "multi-de-electric-last-month",
    type: "multilingual",
    query: "Stromrechnung vom letzten Monat",
    intent: "The electric bill (in English) that arrived in September 2026",
    relevant: ["bill-2026-09"],
    keywords: "Stromrechnung",
  },
  {
    id: "multi-ja-tanaka-quote",
    type: "multilingual",
    query: "田中さんからの見積書",
    intent: "Tanaka's quotation email (in Japanese) with the 見積書 attached",
    relevant: ["hiroshi-quote-ja"],
    keywords: "田中 見積書",
  },
  {
    id: "multi-he-mom-lake",
    type: "multilingual",
    query: "התמונות שאמא שלחה מהאגם",
    intent: "Mom's emails (in English) with pictures from the lake weekend",
    relevant: ["mom-lake-1", "mom-lake-2"],
    keywords: "אמא אגם תמונות",
  },
];
