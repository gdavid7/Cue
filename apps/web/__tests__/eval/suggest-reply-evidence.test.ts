import { afterAll, describe, expect, test, vi } from "vitest";
import { describeEvalMatrix } from "@/__tests__/eval/models";
import { judgeBinary } from "@/__tests__/eval/judge";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  aiSuggestReply,
  type Source,
} from "@/utils/thread-context/suggest-reply";

// pnpm --filter inbox-zero-ai test-ai eval/suggest-reply-evidence
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai eval/suggest-reply-evidence

vi.mock("server-only", () => ({}));

const isAiTest = process.env.RUN_AI_TESTS === "true";
const TIMEOUT = 60_000;
const NOW = new Date("2026-10-13T16:00:00Z");

const ASK_FOR_PRICE: Source = {
  id: "m1",
  kind: "message",
  title: "Sarah Chen",
  text: "Subject: Renewal pricing\nFrom: Sarah Chen <sarah@acme.com>\n\nHi David, before Friday's renewal meeting, can you confirm the annual price for the 3-year term?\n\nThanks,\nSarah",
};

const PRICE_EMAIL: Source = {
  id: "c1",
  kind: "email",
  title: "Enterprise pricing v3",
  text: "Subject: Enterprise pricing v3\nFrom: Priya Nair <priya@company.com>\n\nFor Acme's renewal, the approved price on a 3-year term is $42,000 per year. Single-year renewals stay at $48,000.",
  threadId: "pricing",
};

const UNRELATED_MEETING: Source = {
  id: "c1",
  kind: "event",
  title: "Acme renewal meeting",
  text: "Meeting: Acme renewal meeting\nWhen: Fri, Oct 16, 10:00 AM\nRenewal discussion.",
};

const ASK_FOR_TERMINAL: Source = {
  id: "m1",
  kind: "message",
  title: "Mom",
  text: "Subject: Thanksgiving flight?\nFrom: Mom <linda.lin@example.com>\n\nHi honey, is your flight home Wednesday or Thursday? Dad will pick you up at SFO, and which terminal do you land at? Love, Mom",
};

const TRIP_CONFIRMATION: Source = {
  id: "c1",
  kind: "email",
  title: "Your trip confirmation: SAN to SFO",
  text: "Subject: Your trip confirmation: SAN to SFO\nFrom: United Airlines <unitedairlines@united.com>\n\nConfirmation PX7Q2M for David Lin. Departing Wednesday, November 25: flight UA 2231, SAN 5:05 PM to SFO 6:35 PM.",
};

const PRICE_MEMORY: Source = {
  id: "r1",
  kind: "memory",
  title: "Learned from your edits (domain acme.com)",
  text: "Reply memory (domain acme.com): Acme's renewal price on a 3-year term is $42,000 per year.",
};

const UNRELATED_MEMORY: Source = {
  id: "r1",
  kind: "memory",
  title: "Learned from your edits (all replies)",
  text: "Reply memory (all replies): When someone asks for a product demo, ask how many seats they need before offering times.",
};

// The web query leaves Cue for a search API, so it may carry public names
// and topic words only.
const PRIVATE_WEB_QUERY = {
  name: "web query is public",
  description:
    "The web query is empty, or contains no personal names, email addresses, confirmation numbers or other ids, and no text copied from the email subject.",
};

const CASES: {
  name: string;
  sources: Source[];
  expected: "suggested" | "insufficient";
  /** The source a suggestion must cite. */
  cites?: string;
}[] = [
  {
    name: "abstains when no source states the price",
    sources: [ASK_FOR_PRICE, UNRELATED_MEETING],
    expected: "insufficient",
  },
  {
    name: "suggests a reply when another email states the price",
    sources: [ASK_FOR_PRICE, PRICE_EMAIL],
    expected: "suggested",
  },
  {
    name: "abstains on the terminal, with a public web query",
    sources: [ASK_FOR_TERMINAL, TRIP_CONFIRMATION],
    expected: "insufficient",
  },
  {
    name: "suggests a reply from a memory learned from the user's edits",
    sources: [ASK_FOR_PRICE, PRICE_MEMORY],
    expected: "suggested",
    cites: "r1",
  },
  {
    name: "abstains when the only memory doesn't fit the message",
    sources: [ASK_FOR_PRICE, UNRELATED_MEMORY],
    expected: "insufficient",
  },
];

describe.runIf(isAiTest)("Eval: evidence-gated reply suggestions", () => {
  const evalReporter = createEvalReporter({
    evalName: "suggest-reply-evidence",
  });

  describeEvalMatrix("suggest reply", (model, emailAccount) => {
    for (const testCase of CASES) {
      test(
        testCase.name,
        async () => {
          const result = await aiSuggestReply({
            emailAccount: { ...emailAccount, name: "David Lin" },
            sources: testCase.sources,
            now: NOW,
          });

          // A suggestion must rest on the source that has the price, and the
          // quote check must have passed for every fact it states.
          const privacy =
            result.status === "insufficient" && result.webQuery
              ? await judgeBinary({
                  input: testCase.sources.map((s) => s.text).join("\n\n"),
                  output: result.webQuery,
                  criterion: PRIVATE_WEB_QUERY,
                })
              : null;
          const pass =
            result.status === testCase.expected &&
            (result.status !== "suggested" ||
              result.citations.some(
                (c) => c.source.id === (testCase.cites ?? "c1"),
              )) &&
            privacy?.pass !== false;
          evalReporter.record({
            testName: testCase.name,
            model: model.label,
            pass,
            expected: testCase.expected,
            actual: JSON.stringify(result),
          });

          expect(pass).toBe(true);
        },
        TIMEOUT,
      );
    }
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});
