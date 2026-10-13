import { afterAll, describe, expect, test, vi } from "vitest";
import { getMockMessage } from "@/__tests__/helpers";
import { describeEvalMatrix } from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  aiExtractInsight,
  type EmailInsight,
} from "@/utils/inbox-insights/extract-insight";

// pnpm --filter inbox-zero-ai test-ai eval/inbox-insight
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai eval/inbox-insight

vi.mock("server-only", () => ({}));

const isAiTest = process.env.RUN_AI_TESTS === "true";
const TIMEOUT = 60_000;
// Tuesday.
const NOW = new Date("2026-10-13T16:00:00Z");

const CASES: {
  name: string;
  from: string;
  subject: string;
  body: string;
  pass: (insight: EmailInsight) => boolean;
}[] = [
  {
    name: "says nothing about a newsletter",
    from: "Morning Brew <crew@morningbrew.com>",
    subject: "Fed holds rates, Apple's new chip",
    body: "Good morning. The Fed held rates steady yesterday, and Apple unveiled its newest chip. Here's what it means for you.",
    pass: (i) => i.action === "none" && !i.task && !i.fact,
  },
  {
    name: "sees a request for a reply",
    from: "Jessica Park <jpark@nvidia.com>",
    subject: "Next steps",
    body: "Hi David, could you share your availability for two technical interviews next week?",
    pass: (i) => i.action === "reply" && i.task.length > 0,
  },
  {
    name: "sees a task with a deadline that isn't a reply",
    from: "Housing <housing@ucsd.edu>",
    subject: "Winter housing payment",
    body: "Your winter quarter housing payment of $2,450 is due by Friday, October 16. Pay online through the housing portal.",
    pass: (i) =>
      i.action === "do" &&
      i.dateRole === "deadline" &&
      i.date?.startsWith("2026-10-16") === true,
  },
  {
    name: "keeps the confirmation code from a receipt, without inventing a task",
    from: "United <receipts@united.com>",
    subject: "Your trip confirmation",
    body: "Your flight is confirmed. Confirmation PX7Q2M. Departing Wednesday, November 25: SAN 5:05 PM to SFO 6:35 PM.",
    pass: (i) => i.action === "none" && i.fact?.includes("PX7Q2M") === true,
  },
];

describe.runIf(isAiTest)("Eval: inbox insight", () => {
  const evalReporter = createEvalReporter({ evalName: "inbox-insight" });

  describeEvalMatrix("inbox insight", (model, emailAccount) => {
    for (const testCase of CASES) {
      test(
        testCase.name,
        async () => {
          const insight = await aiExtractInsight({
            emailAccount,
            message: getMockMessage({
              from: testCase.from,
              to: "david@example.com",
              subject: testCase.subject,
              textPlain: testCase.body,
              snippet: testCase.body,
            }),
            timezone: "America/Los_Angeles",
            now: NOW,
          });

          const pass = testCase.pass(insight);
          evalReporter.record({
            testName: testCase.name,
            model: model.label,
            pass,
            actual: JSON.stringify(insight),
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
