import { afterAll, describe, expect, test, vi } from "vitest";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  formatSemanticJudgeActual,
  judgeEvalOutput,
} from "@/__tests__/eval/semantic-judge";
import { TZDate } from "@date-fns/tz";
import {
  aiInterpretSearch,
  buildSearchIntentPrompt,
  toSearchIntent,
} from "@/utils/ai/mail-search/interpret-search";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";

// pnpm --filter inbox-zero-ai test-ai eval/search-intent
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai eval/search-intent

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 60_000;
// Monday.
const NOW = new Date("2026-10-19T17:00:00Z");
const TIMEZONE = "America/Los_Angeles";
const LABELS = ["Receipts", "Travel", "Work/Clients"];

const CRITERION = {
  name: "The search finds the mail the user means",
  description: `The output holds the Gmail-syntax search Cue built from the model's reading of what the user typed into the search bar. Every term and bracketed group must match; words inside a group are alternatives. Dates are shown in the account's time zone; before: is exclusive.
Judge meaning, not exact strings. PASS when the search would find the mail the user describes: people they name are in from: or to: (as written, or an obvious form of it); each date phrase is resolved correctly against today's date (a calendar period or an equivalent rolling window are both fine); attachments are required only when a file is implied; the words are ones that mail would contain, with alternatives grouped, in a language that mail is likely written in; a label is used only when the user names one that exists.
FAIL when the search adds a sender, date, label or other restriction the user didn't imply (a role such as "my landlord" is not a sender name), leaves out one they stated, gets a date range wrong, treats the date of an event the mail is about as the date the mail arrived, or requires incidental words (the user's filler, the question words) so the obvious matching email would be missed. Also FAIL when the explanation misdescribes the search or isn't in the language of the query.`,
};

const CASES: {
  name: string;
  query: string;
  expected: string;
  /** Left out where reasonable readings differ. */
  isQuestion?: boolean;
}[] = [
  {
    name: "a document from a person last month",
    query: "the lease contract Sarah sent last month",
    expected:
      "from:sarah, September 2026 (after:2026/09/01 before:2026/10/01 or similar), lease or contract; has:attachment is fine",
    isQuestion: false,
  },
  {
    name: "a question about a flight",
    query: "when is my flight?",
    expected:
      "flight, itinerary, boarding pass or booking confirmation words with OR; no invented airline or sender",
    isQuestion: true,
  },
  {
    name: "invoices from a company this year",
    query: "invoices from Acme this year",
    expected: "from:acme, after:2026/01/01, invoice terms",
    isQuestion: false,
  },
  {
    name: "photos from family over the summer",
    query: "photos my mom sent over the summer",
    expected:
      "has:attachment or photo words, summer 2026 (roughly June to August); a sender restriction isn't needed for 'mom', who can't be looked up by name",
    isQuestion: false,
  },
  {
    name: "a question about what someone said",
    query: "what did Priya say about the Q3 budget?",
    expected: "from:priya with budget (and Q3) words",
    isQuestion: true,
  },
  {
    name: "unread mail from a landlord",
    query: "unread emails from my landlord",
    expected:
      "is:unread with landlord, rent or lease words; no from: guess at the landlord's address",
    isQuestion: false,
  },
  {
    name: "an existing label",
    query: "amazon orders in my receipts label",
    expected: "label:Receipts with amazon (from:amazon or the word)",
    isQuestion: false,
  },
  {
    name: "mail the user sent",
    query: "emails I sent to Tom last week",
    expected:
      "in:sent or from:me, to:tom, last week: Monday Oct 12 up to Monday Oct 19, 2026 (or the past 7 days)",
    isQuestion: false,
  },
  {
    name: "a signed attachment",
    query: "the PDF with the signed NDA",
    expected: "has:attachment with NDA or non-disclosure words; no date",
    isQuestion: false,
  },
  {
    name: "starred mail about a topic",
    query: "starred messages about the offsite",
    expected: "is:starred with offsite (retreat is a fine synonym)",
    isQuestion: false,
  },
  {
    name: "Spanish: a contract from a person in a named month",
    query: "el contrato de alquiler que me mandó Carlos en septiembre",
    expected:
      "from:carlos, September 2026, contrato or alquiler words (Spanish words are expected)",
    isQuestion: false,
  },
  {
    name: "French: a question about an appointment",
    query: "quand est mon rendez-vous chez le dentiste ?",
    expected:
      "dentist appointment words such as dentiste or rendez-vous; explanation in French",
    isQuestion: true,
  },
  {
    name: "German: invoices from last quarter",
    query: "Rechnungen von der Telekom aus dem letzten Quartal",
    expected:
      "from:telekom (or the word), Rechnung words, Q3 2026 (after:2026/07/01 before:2026/10/01) or a three-month window; explanation in German",
    isQuestion: false,
  },
  {
    name: "Japanese: a quote from last week",
    query: "先週田中さんから届いた見積書",
    expected:
      "from Tanaka (田中 or tanaka), 見積書 or estimate/quote words, last week (Oct 12 up to Oct 19, 2026, or the past 7 days); explanation in Japanese",
    isQuestion: false,
  },
  {
    name: "Hebrew: a question about a flight",
    query: "מתי הטיסה שלי לתל אביב?",
    expected:
      "flight words (טיסה, or English flight/itinerary alongside), Tel Aviv; no invented sender; explanation in Hebrew",
    isQuestion: true,
  },
  {
    name: "Portuguese: wedding photos from a person",
    query: "fotos do casamento que a Ana enviou",
    expected:
      "from:ana, has:attachment or fotos words, casamento; explanation in Portuguese",
    isQuestion: false,
  },
  {
    name: "Chinese: a quotation from last month",
    query: "王经理上个月发给我的报价单",
    expected:
      "from Wang (王 or wang), September 2026, 报价单 or quotation words; explanation in Chinese",
    isQuestion: false,
  },
  {
    name: "unread newsletters this week",
    query: "newsletters I haven't read this week",
    expected:
      "is:unread, this week (since Monday Oct 19, 2026, or the past 7 days), newsletter words or unsubscribe",
    isQuestion: false,
  },
  {
    name: "a yes-or-no question about a mortgage",
    query: "did the bank approve my mortgage?",
    expected:
      "mortgage with approval or loan words; no from: guess at the bank",
    isQuestion: true,
  },
  {
    name: "a shipping notice without a date",
    query: "shipping confirmation for the headphones I ordered",
    expected:
      "headphones with shipping, shipped, tracking or order words; no date restriction",
    isQuestion: false,
  },
  {
    name: "a vague sender",
    query: "anything from the school about the field trip",
    expected:
      "field trip words, with school as a word or a from: guess; no invented address or date",
  },
  {
    name: "an interview link for tomorrow",
    query: "the zoom link for tomorrow's interview",
    expected:
      "zoom with interview words; a date restriction is optional, but if present it must not exclude mail sent in the last weeks",
  },
];

describe.runIf(shouldRunEval)("search-intent eval", () => {
  const evalReporter = createEvalReporter({ evalName: "search-intent" });

  describeEvalMatrix("search intent", (model, emailAccount) => {
    for (const testCase of CASES) {
      test(
        testCase.name,
        async () => {
          // The intent call runs on the economy tier; a user key routes every
          // tier to the matrix model, so this grades the model under test.
          expect(
            getModelForUseCase(emailAccount.user, LlmUseCase.SearchIntent)
              .modelName,
          ).toBe(model.model);
          const parts = await aiInterpretSearch({
            emailAccount: { ...emailAccount, timezone: TIMEZONE },
            query: testCase.query,
            now: NOW,
          });
          const intent = toSearchIntent(parts, {
            now: NOW,
            timeZone: TIMEZONE,
            provider: "google",
            labelNames: LABELS,
          });
          const output = {
            // Epoch seconds, as Gmail gets them, written out for the judge.
            search: readableDates(intent.searches[0] ?? ""),
            explanation: intent.explanation,
            isQuestion: intent.isQuestion,
          };

          const judgeResult = await judgeEvalOutput({
            criterion: CRITERION,
            expected: testCase.expected,
            input: `${buildSearchIntentPrompt({ query: testCase.query, now: NOW, timeZone: TIMEZONE })}

The account's labels: ${LABELS.join(", ")}`,
            output: JSON.stringify(output, null, 2),
          });
          const questionCorrect =
            testCase.isQuestion === undefined ||
            output.isQuestion === testCase.isQuestion;
          const pass =
            judgeResult.pass && questionCorrect && intent.searches.length > 0;

          evalReporter.record({
            testName: testCase.name,
            model: model.label,
            pass,
            expected: testCase.expected,
            actual: formatSemanticJudgeActual(
              JSON.stringify(output),
              judgeResult,
            ),
          });

          expect(intent.searches.length).toBeGreaterThan(0);
          expect(questionCorrect, "isQuestion").toBe(true);
          expect(judgeResult.pass, judgeResult.reasoning).toBe(true);
        },
        TIMEOUT,
      );
    }
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});

function readableDates(search: string) {
  return search.replace(
    /\b(after|before):(\d{9,11})\b/g,
    (_, name: string, seconds: string) => {
      const local = new TZDate(Number(seconds) * 1000, TIMEZONE);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${name}:${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
    },
  );
}
