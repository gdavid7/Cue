import { afterAll, describe, expect, test } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { judgeBinary } from "@/__tests__/eval/judge";
import { getEvalJudgeUserAi } from "@/__tests__/eval/judge-provider";
import {
  classifyCases,
  USER_EMAIL,
  type ClassifyCase,
} from "@/__tests__/eval/classify-conversations.cases";
import { aiChooseRule } from "@/utils/ai/choose-rule/ai-choose-rule";
import { CONVERSATION_TRACKING_INSTRUCTIONS } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import { getRule } from "@/__tests__/helpers";
import { stringifyEmail } from "@/utils/stringify-email";
import { createScopedLogger } from "@/utils/logger";

// Measures whether person-written mail reaches the "Conversations" meta-rule,
// the only path to To Reply and rule drafts, against automated look-alikes.
//
// pnpm --filter inbox-zero-ai test-ai __tests__/eval/classify-conversations
// EVAL_MODELS=claude-haiku-5.5-anthropic pnpm --filter inbox-zero-ai test-ai __tests__/eval/classify-conversations

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 60_000;
const logger = createScopedLogger("eval-classify-conversations");

// Mirrors the default candidate set a Gmail account sees in production:
// system rules carry their systemType so canonical ordering matches, and the
// Conversations meta-rule has none, so it is listed last.
const systemRule = (type: SystemType) => {
  const config = getRuleConfig(type);
  return { ...getRule(config.instructions, [], config.name), systemType: type };
};
const conversations = {
  ...getRule(CONVERSATION_TRACKING_INSTRUCTIONS, [], "Conversations"),
  runOnThreads: true,
};
const notification = systemRule(SystemType.NOTIFICATION);

const newMessageRules = [
  systemRule(SystemType.NEWSLETTER),
  systemRule(SystemType.MARKETING),
  systemRule(SystemType.CALENDAR),
  systemRule(SystemType.RECEIPT),
  notification,
  conversations,
];

// Replies in a thread skip runOnThreads=false rules unless one was already
// applied in the thread; production logs show this pair for thread replies.
const threadReplyRules = [notification, conversations];

const AMBIGUOUS_CRITERION = {
  name: "Defensible filing",
  description: [
    "The output is the category an email client filed this email under.",
    "PASS if a careful assistant could defend this choice.",
    "If a real person wrote the message to the recipient (including through a tool or platform that adds a footer) and it asks them something, expects a response, or keeps an exchange with them going, only 'Conversations' is defensible.",
    "If the message is machine-generated or sent to many people without being addressed to the recipient personally, any automated category that fits its purpose is defensible.",
  ].join(" "),
};

type Outcome = {
  model: string;
  testCase: ClassifyCase;
  actual: string;
  pass: boolean;
};

describe.runIf(shouldRunEval)("Eval: classify conversations", () => {
  const evalReporter = createEvalReporter({
    evalName: "classify-conversations",
  });
  const outcomes: Outcome[] = [];

  describeEvalMatrix(
    "classify-conversations",
    (model, emailAccount) => {
      for (const tc of classifyCases) {
        const testName = `${tc.kind}${tc.thread ? " (thread)" : ""}: ${tc.name} -> ${tc.acceptable.join(" | ")}`;
        test(
          testName,
          async () => {
            const result = await aiChooseRule({
              email: tc.email,
              rules: tc.thread ? threadReplyRules : newMessageRules,
              emailAccount,
              logger,
            });

            const primary = result.rules.find((r) => r.isPrimary);
            const actual =
              primary?.rule.name ?? result.rules[0]?.rule.name ?? "no match";

            let pass = tc.acceptable.includes(actual);
            const criteria =
              !pass && tc.ambiguous
                ? [
                    await judgeBinary({
                      input: stringifyEmail(tc.email, 2000),
                      output: actual,
                      expected: tc.acceptable.join(" or "),
                      criterion: AMBIGUOUS_CRITERION,
                      judgeUserAi: getEvalJudgeUserAi(),
                    }),
                  ]
                : undefined;
            if (criteria) pass = criteria[0].pass;

            outcomes.push({ model: model.label, testCase: tc, actual, pass });
            evalReporter.record({
              testName,
              model: model.label,
              pass,
              expected: tc.acceptable.join(" | "),
              actual,
              criteria,
            });

            expect(pass, `chose ${actual}`).toBe(true);
          },
          TIMEOUT,
        );
      }
    },
    { email: USER_EMAIL },
  );

  afterAll(() => {
    evalReporter.printReport();
    printConfusion(outcomes);
  });
});

function printConfusion(outcomes: Outcome[]) {
  const models = [...new Set(outcomes.map((o) => o.model))];

  for (const model of models) {
    const rows = outcomes.filter((o) => o.model === model);
    const people = rows.filter((o) => o.testCase.kind === "person");
    const automated = rows.filter((o) => o.testCase.kind === "automated");
    const peopleAsConversations = people.filter(
      (o) => o.actual === "Conversations",
    );
    const automatedAsConversations = automated.filter(
      (o) => o.actual === "Conversations",
    );
    const personalTabPeople = people.filter(
      (o) => o.testCase.gmailCategory === "PERSONAL",
    );

    const lines = [
      `\n=== classify-conversations confusion [${model}] ===`,
      `pass ${rows.filter((o) => o.pass).length}/${rows.length}`,
      `person-written -> Conversations: ${peopleAsConversations.length}/${people.length} (recall)`,
      `automated -> Conversations: ${automatedAsConversations.length}/${automated.length} (false positives)`,
      `person-written in Gmail PERSONAL -> Conversations: ${personalTabPeople.filter((o) => o.actual === "Conversations").length}/${personalTabPeople.length}`,
      "person-written lost to:",
      ...countBy(
        people.filter((o) => o.actual !== "Conversations"),
        (o) => o.actual,
      ).map(([label, n]) => `  ${label}: ${n}`),
      "automated misfiled as Conversations:",
      ...automatedAsConversations.map(
        (o) => `  ${o.testCase.name} (${o.testCase.gmailCategory})`,
      ),
      "misses:",
      ...rows
        .filter((o) => !o.pass)
        .map(
          (o) =>
            `  [${o.testCase.kind}/${o.testCase.gmailCategory}${o.testCase.thread ? "/thread" : ""}] ${o.testCase.name}: ${o.actual}`,
        ),
    ];
    console.log(lines.join("\n"));
  }
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
