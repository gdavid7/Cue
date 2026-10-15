// Mail the journeys robot plants with facts only it knows, the chat questions
// whose answers are those facts, and the checks that grade an answer by its
// facts rather than its wording. Every value is generated from the run's tag,
// so no run can pass by finding an earlier run's mail or a cached answer, and
// the made-up names never collide with real mail.

/** Every message the journeys robot creates carries this word in its subject. */
export const JOURNEY_SUBJECT_MARKER = "cqj";
/** Sender domain for planted mail: reserved, so nothing can reach a person. */
const SEED_DOMAIN = "example.com";

export type Fact = {
  key: string;
  /** An optional fact is reported but does not fail the answer. */
  required: boolean;
  /** Normalized forms, any one of which counts as the fact being present. */
  anyOf: string[];
};

export type ChatQuestion = { id: string; question: string; facts: Fact[] };

export type PlantedEmail = {
  key: string;
  subject: string;
  from: { name: string; address: string };
  text: string;
  date: Date;
};

export type GroundTruth = ReturnType<typeof buildGroundTruth>;

export function journeySubject(base: string, runTag: string) {
  return `${base} · ${JOURNEY_SUBJECT_MARKER} ${runTag}`;
}

export function buildGroundTruth({
  runTag,
  now = new Date(),
}: {
  runTag: string;
  now?: Date;
}) {
  const random = seededRandom(runTag);
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)] as T;
  const word = () => {
    const name = `${pick(SYLLABLES)}${pick(SYLLABLES)}${pick(ENDINGS)}`;
    return name[0].toUpperCase() + name.slice(1);
  };
  const day = (min: number, max: number) =>
    new Date(
      now.getTime() +
        (min + Math.floor(random() * (max - min + 1))) * 86_400_000,
    );

  const company = `${word()} ${pick(COMPANY_KINDS)}`;
  const companyWord = company.split(" ")[0];
  const role = pick(ROLES);
  const offerDeadline = day(6, 13);

  const person = `${pick(FIRST_NAMES)} ${word()}`;
  const personSurname = person.split(" ")[1];
  const topic = pick(MEETING_TOPICS);
  const meetingDay = day(2, 5);
  const hour = 1 + Math.floor(random() * 4);
  const minute = pick([10, 20, 40, 50]);
  const room = `${pick(["B", "C", "D", "F"])}${2 + Math.floor(random() * 7)}-${100 + Math.floor(random() * 800)}`;

  const vendor = `${word()} ${pick(VENDOR_KINDS)}`;
  const vendorWord = vendor.split(" ")[0];
  const invoiceNumber = `INV-${10_000 + Math.floor(random() * 89_999)}`;
  const dollars = 1000 + Math.floor(random() * 8999);
  const cents = 10 + Math.floor(random() * 89);
  const amount = `$${dollars.toLocaleString("en-US")}.${cents}`;
  const invoiceDue = day(8, 14);

  const meetingTime = `${hour}:${minute} PM`;
  const emails: PlantedEmail[] = [
    {
      key: "offer",
      subject: journeySubject(`Your offer from ${company}`, runTag),
      from: sender(`Talent team at ${company}`, `talent.${companyWord}`),
      date: new Date(now.getTime() - 50 * 60_000),
      text: [
        "Hi,",
        "",
        `We are delighted to offer you the position of ${role} at ${company}.`,
        `Please let us know your decision by ${formatLongDate(offerDeadline)}. After that date the offer lapses.`,
        "Your manager will reach out with onboarding details once you accept.",
        "",
        `Best regards,\nThe ${company} talent team`,
      ].join("\n"),
    },
    {
      key: "meeting",
      subject: journeySubject(`${topic} sync`, runTag),
      from: sender(person, `${person.split(" ")[0]}.${personSurname}`),
      date: new Date(now.getTime() - 40 * 60_000),
      text: [
        "Hi,",
        "",
        `Let's meet on ${formatLongDate(meetingDay)} at ${meetingTime} to go over the ${topic.toLowerCase()}.`,
        `I booked room ${room} on the second floor. Bring the latest numbers if you have them.`,
        "",
        `Thanks,\n${person}`,
      ].join("\n"),
    },
    {
      key: "invoice",
      subject: journeySubject(
        `Invoice ${invoiceNumber} from ${vendor}`,
        runTag,
      ),
      from: sender(`${vendor} billing`, `billing.${vendorWord}`),
      date: new Date(now.getTime() - 30 * 60_000),
      text: [
        "Hello,",
        "",
        `Please find invoice ${invoiceNumber} for services rendered this month.`,
        `Amount due: ${amount}`,
        `Payment is due by ${formatLongDate(invoiceDue)}.`,
        "",
        `Thank you for your business,\n${vendor}`,
      ].join("\n"),
    },
  ];

  const questions: ChatQuestion[] = [
    {
      id: "offer",
      question: `I got a job offer from ${company}. What role is it for, and by when do I have to respond?`,
      facts: [
        { key: "role", required: true, anyOf: [normalizeForMatch(role)] },
        { key: "deadline", required: true, anyOf: dateForms(offerDeadline) },
      ],
    },
    {
      id: "meeting",
      question: `When and where am I meeting ${person}?`,
      facts: [
        { key: "time", required: true, anyOf: timeForms(hour, minute) },
        { key: "room", required: true, anyOf: roomForms(room) },
        { key: "date", required: false, anyOf: dateForms(meetingDay) },
      ],
    },
    {
      id: "invoice",
      question: `How much do I owe ${vendor}, and when is the payment due?`,
      facts: [
        { key: "amount", required: true, anyOf: amountForms(dollars, cents) },
        { key: "due", required: true, anyOf: dateForms(invoiceDue) },
      ],
    },
    {
      // Needs the assistant to look across mail rather than look one up.
      id: "deadlines",
      question:
        "Which emails from the last day ask me to respond or pay by a deadline in the next two weeks?",
      facts: [
        {
          key: "offer",
          required: true,
          anyOf: [normalizeForMatch(companyWord)],
        },
        {
          key: "invoice",
          required: true,
          anyOf: [normalizeForMatch(vendorWord)],
        },
      ],
    },
  ];

  return {
    emails,
    questions,
    /** A word only the invoice contains, for the search journey. */
    searchTerm: vendorWord,
    searchSubject: emails[2].subject,
    /** The planted message the triage journey opens, archives and restores. */
    triageSubject: emails[1].subject,
    triageBodyText: `I booked room ${room}`,
  };
}

/**
 * Grades an answer by the facts it states. Wording, order and extra text do
 * not matter; each fact needs one of its accepted forms.
 */
export function matchFacts(answer: string, facts: Fact[]) {
  const text = normalizeForMatch(answer);
  const found = (fact: Fact) =>
    fact.anyOf.some((form) => containsForm(text, form));
  return {
    matched: facts.filter(found).map((fact) => fact.key),
    missing: facts
      .filter((fact) => fact.required && !found(fact))
      .map((fact) => fact.key),
    missingOptional: facts
      .filter((fact) => !fact.required && !found(fact))
      .map((fact) => fact.key),
  };
}

/** Lowercase, one space, plain dashes, no thousands separators or ordinals. */
export function normalizeForMatch(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[‐-―−]/g, "-")
    .replaceAll(/(\d),(?=\d{3}\b)/g, "$1")
    .replaceAll(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
    .replaceAll(/\b([ap])\.\s?m\.?/g, "$1m")
    .replaceAll(/(\d)\s*([ap]m)\b/g, "$1 $2")
    .replaceAll(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./g, "$1")
    .replaceAll(/[*_`]/g, "")
    .replaceAll(",", " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export type StreamSummary = ReturnType<typeof parseUiMessageStream>;

/**
 * Reads an AI SDK UI message stream (server-sent events of JSON chunks): the
 * answer's text, which tools ran, and every tool or stream error. A tool that
 * returns `{ error }` counts as failed, as the chat shows it.
 */
export function parseUiMessageStream(raw: string) {
  const toolNames = new Map<string, string>();
  const toolCalls: string[] = [];
  const toolErrors: { tool: string; kind: string }[] = [];
  let text = "";
  let streamErrors = 0;
  let finished = false;
  let unparsable = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload);
    } catch {
      unparsable += 1;
      continue;
    }
    const id = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    const name = () =>
      (typeof chunk.toolName === "string" ? chunk.toolName : null) ??
      toolNames.get(id) ??
      "unknown";
    switch (chunk.type) {
      case "text-delta":
        if (typeof chunk.delta === "string") text += chunk.delta;
        break;
      case "tool-input-start":
      case "tool-input-available":
        if (!toolNames.has(id)) {
          toolNames.set(id, name());
          toolCalls.push(name());
        }
        break;
      case "tool-input-error":
      case "tool-output-error":
        toolErrors.push({ tool: name(), kind: chunk.type });
        break;
      case "tool-output-available":
        if (
          typeof chunk.output === "object" &&
          chunk.output !== null &&
          "error" in chunk.output
        ) {
          toolErrors.push({ tool: name(), kind: "tool-returned-error" });
        }
        break;
      case "error":
        streamErrors += 1;
        break;
      case "finish":
        finished = true;
        break;
    }
  }
  return { text, toolCalls, toolErrors, streamErrors, finished, unparsable };
}

function containsForm(text: string, form: string) {
  // Digits and words must not run on, so "11/7" does not match "11/17".
  const escaped = form.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(text);
}

function dateForms(date: Date) {
  const month = MONTHS[date.getUTCMonth()];
  const short = month.slice(0, 3);
  const dayOfMonth = date.getUTCDate();
  const monthNumber = date.getUTCMonth() + 1;
  const iso = date.toISOString().slice(0, 10);
  return [
    `${month} ${dayOfMonth}`,
    `${short} ${dayOfMonth}`,
    ...(short === "sep" ? [`sept ${dayOfMonth}`] : []),
    `${dayOfMonth} ${month}`,
    `${dayOfMonth} ${short}`,
    `${monthNumber}/${dayOfMonth}`,
    iso,
  ];
}

function timeForms(hour: number, minute: number) {
  return [`${hour}:${minute} pm`, `${hour + 12}:${minute}`];
}

function roomForms(room: string) {
  const normalized = normalizeForMatch(room);
  return [
    normalized,
    normalized.replace("-", " "),
    normalized.replace("-", ""),
  ];
}

function amountForms(dollars: number, cents: number) {
  return [`${dollars}.${cents}`];
}

function formatLongDate(date: Date) {
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  const label = `${month[0].toUpperCase()}${month.slice(1)}`;
  return `${weekday}, ${label} ${date.getUTCDate()}`;
}

function sender(name: string, local: string) {
  return { name, address: `${local.toLowerCase()}@${SEED_DOMAIN}` };
}

/** A small deterministic generator, so a run tag always plants the same facts. */
function seededRandom(seed: string) {
  let state = 2_166_136_261;
  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 16_777_619);
  }
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const SYLLABLES = [
  "vor",
  "kel",
  "dra",
  "min",
  "tas",
  "quo",
  "zel",
  "bri",
  "nox",
  "pel",
  "rua",
  "tov",
];
const ENDINGS = ["ix", "ane", "ora", "eth", "ula", "yn"];
const COMPANY_KINDS = ["Labs", "Systems", "Analytics", "Robotics"];
const VENDOR_KINDS = ["Supply", "Printing", "Hosting", "Logistics"];
const ROLES = [
  "Senior Data Analyst",
  "Product Designer",
  "Backend Engineer",
  "Operations Manager",
  "Research Scientist",
];
const FIRST_NAMES = ["Priya", "Marcus", "Elena", "Tomas", "Aiko", "Nadia"];
const MEETING_TOPICS = [
  "Quarterly budget",
  "Launch checklist",
  "Hiring plan",
  "Vendor review",
];
