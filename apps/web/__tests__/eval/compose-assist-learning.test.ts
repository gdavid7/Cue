import { afterAll, describe, expect, test } from "vitest";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { judgeBinary } from "@/__tests__/eval/judge";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { getEvalJudgeUserAi } from "@/__tests__/eval/judge-provider";
import { ReplyMemoryKind } from "@/generated/prisma/enums";
import type { ComposeAssistOutcome } from "@/utils/actions/compose-assist.validation";
import { aiExtractReplyMemoriesFromDraftEdit } from "@/utils/ai/reply/extract-reply-memories";
import { isDefined } from "@/utils/types";

// What reply memories learn from how the user handled Cue's suggestions in the
// composer: accepted, refined, edited after accepting, or discarded.
// pnpm --filter inbox-zero-ai test-ai __tests__/eval/compose-assist-learning.test.ts

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 180_000;
const evalReporter = createEvalReporter({
  evalName: "compose-assist-learning",
});

type Scenario = {
  name: string;
  incomingEmailContent: string;
  senderEmail: string;
  outcomes: ComposeAssistOutcome[];
  sentText: string;
  expectsMemory: boolean;
  allowedKinds?: ReplyMemoryKind[];
  expected: string;
  criterion: { name: string; description: string };
};

const scenarios: Scenario[] = [
  {
    name: "learns a style preference from follow-up requests",
    incomingEmailContent:
      "Hi! Could you send over the Q3 report when you get a chance? Thanks!",
    senderEmail: "maria@partnerco.com",
    outcomes: [
      {
        outcome: "accepted",
        request: "Improve",
        refinements: [
          "no exclamation marks",
          "skip the 'hope this finds you well' opener",
        ],
        original: "hey maria attached is q3 report lmk if questions",
        suggestion:
          "Hi Maria,\n\nAttached is the Q3 report. Let me know if you have any questions.",
      },
    ],
    sentText:
      "Hi Maria,\n\nAttached is the Q3 report. Let me know if you have any questions.",
    expectsMemory: true,
    allowedKinds: [ReplyMemoryKind.PREFERENCE],
    expected:
      "A PREFERENCE memory saying to avoid exclamation marks and/or filler openers such as 'hope this finds you well'.",
    criterion: {
      name: "Preference from follow-up requests",
      description:
        "The memories should capture the lasting style preference the user expressed in their follow-up requests to Cue (no exclamation marks, no filler opener), written as a reusable drafting instruction rather than a description of this one email.",
    },
  },
  {
    name: "learns a business fact the user added to an accepted suggestion",
    incomingEmailContent:
      "We're ready to move ahead. How long does the data migration take once we sign?",
    senderEmail: "ops@clientcorp.com",
    outcomes: [
      {
        outcome: "accepted",
        request: "say we can do the migration",
        refinements: [],
        original: "",
        suggestion:
          "Great to hear. We can complete the migration by [date] once the contract is signed.",
      },
    ],
    sentText:
      "Great to hear. We complete migrations within 10 business days of signing, and we never run them during a customer's month-end close.",
    expectsMemory: true,
    allowedKinds: [ReplyMemoryKind.FACT, ReplyMemoryKind.PROCEDURE],
    expected:
      "A FACT or PROCEDURE memory that migrations take about 10 business days after signing and/or are never run during month-end close.",
    criterion: {
      name: "Fact from editing an accepted suggestion",
      description:
        "The memories should capture the reusable business information the user wrote in place of Cue's placeholder: the migration timeline after signing and/or the month-end close restriction.",
    },
  },
  {
    name: "learns from a discarded suggestion the user wrote differently",
    incomingEmailContent:
      "Would your team be interested in sponsoring our community meetup next month? Packages start at $2,000.",
    senderEmail: "events@meetupgroup.org",
    outcomes: [
      {
        outcome: "discarded",
        request: "politely decline",
        refinements: [],
        original: "",
        suggestion:
          "Thank you so much for thinking of us! We truly appreciate the invitation and the work you put into this community. Unfortunately, after careful consideration, we are not able to sponsor the meetup this time. We are so sorry and hope you understand. Please keep us in mind for future events!",
      },
    ],
    sentText: "Thanks for the invite. We'll pass on sponsoring this one.",
    expectsMemory: true,
    allowedKinds: [ReplyMemoryKind.PREFERENCE, ReplyMemoryKind.PROCEDURE],
    expected:
      "A memory that declines should be short and direct, without heavy apologies or effusive thanks.",
    criterion: {
      name: "Preference from a discarded suggestion",
      description:
        "The memories should capture that the user declines briefly and directly rather than with long apologetic, effusive wording, as shown by the suggestion they discarded and the reply they wrote instead. It must not invent facts such as a sponsorship budget policy.",
    },
  },
  {
    name: "learns nothing from a one-off placeholder fill",
    incomingEmailContent: "Can we move our call this week? Something came up.",
    senderEmail: "sam@example.com",
    outcomes: [
      {
        outcome: "accepted",
        request: "Shorter",
        refinements: [],
        original:
          "No problem at all, these things happen, would [day] work for you instead? Let me know what suits you best.",
        suggestion: "No problem. Would [day] work instead?",
      },
    ],
    sentText: "No problem. Would Thursday work instead?",
    expectsMemory: false,
    expected: "No memories.",
    criterion: {
      name: "No memory from a one-off scheduling detail",
      description:
        "Filling a date placeholder for one reschedule teaches nothing durable, and a single 'Shorter' request on one passage is not a lasting preference. The output should contain no memories.",
    },
  },
];

describe.runIf(shouldRunEval)("compose assist learning eval", () => {
  describeEvalMatrix("compose assist learning", (model, emailAccount) => {
    const replyMemoryEmailAccount = emailAccount as Parameters<
      typeof aiExtractReplyMemoriesFromDraftEdit
    >[0]["emailAccount"];

    for (const scenario of scenarios) {
      test(
        scenario.name,
        async () => {
          const decisions = await aiExtractReplyMemoriesFromDraftEdit({
            emailAccount: replyMemoryEmailAccount,
            incomingEmailContent: scenario.incomingEmailContent,
            draftText: "",
            composeAssistOutcomes: scenario.outcomes,
            sentText: scenario.sentText,
            senderEmail: scenario.senderEmail,
            existingMemories: [],
          });
          const memories = decisions
            .map((decision) => decision.newMemory)
            .filter(isDefined);
          const summary = memories.length
            ? memories
                .map(
                  (memory) =>
                    `[${memory.kind} | ${memory.scopeType}${memory.scopeValue ? `:${memory.scopeValue}` : ""}] ${memory.content}`,
                )
                .join(" || ")
            : "none";

          const hasExpectedStructure = scenario.expectsMemory
            ? memories.some((memory) =>
                (scenario.allowedKinds ?? []).includes(memory.kind),
              )
            : memories.length === 0;
          const judgeResult = await judgeBinary({
            input: buildJudgeInput(scenario),
            output: summary,
            expected: scenario.expected,
            criterion: scenario.criterion,
            judgeUserAi: getEvalJudgeUserAi(),
          });
          const pass = hasExpectedStructure && judgeResult.pass;

          evalReporter.record({
            testName: scenario.name,
            model: model.label,
            pass,
            expected: scenario.expected,
            actual: `${summary}; judge=${judgeResult.pass ? "PASS" : "FAIL"} (${judgeResult.reasoning})`,
            criteria: [judgeResult],
          });

          expect(hasExpectedStructure).toBe(true);
          expect(judgeResult.pass).toBe(true);
        },
        TIMEOUT,
      );
    }
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});

function buildJudgeInput(scenario: Scenario) {
  return [
    "## Incoming Email",
    scenario.incomingEmailContent,
    "",
    "## What the user did with Cue's suggestions",
    ...scenario.outcomes.map((outcome) =>
      [
        `- ${outcome.outcome.toUpperCase()}: asked for "${outcome.request}"`,
        ...outcome.refinements.map((text) => `  follow-up: "${text}"`),
        outcome.original ? `  replaced: ${outcome.original}` : "",
        `  Cue suggested: ${outcome.suggestion}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "## Final Sent Reply",
    scenario.sentText,
  ].join("\n");
}
