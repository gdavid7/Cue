import { afterAll, describe, expect, test, vi } from "vitest";
import { describeEvalMatrix } from "@/__tests__/eval/models";
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

const CASES: {
  name: string;
  sources: Source[];
  expected: "suggested" | "insufficient";
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

          // A suggestion must rest on the email that has the price, and the
          // quote check must have passed for every fact it states.
          const pass =
            result.status === testCase.expected &&
            (result.status !== "suggested" ||
              result.citations.some((c) => c.source.id === "c1"));
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
