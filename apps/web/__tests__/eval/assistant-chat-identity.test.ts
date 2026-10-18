import { afterAll, describe, expect, test } from "vitest";
import {
  captureAssistantChatTrace,
  hasAssistantWriteToolCalls,
} from "@/__tests__/eval/assistant-chat-eval-utils";
import {
  setupInboxWorkflowEval,
  shouldRunEval,
  TIMEOUT,
} from "@/__tests__/eval/assistant-chat-inbox-workflows-test-utils";
import { describeEvalMatrix } from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import {
  formatSemanticJudgeActual,
  judgeEvalOutput,
} from "@/__tests__/eval/semantic-judge";
import { createScopedLogger } from "@/utils/logger";

// pnpm --filter inbox-zero-ai test-ai __tests__/eval/assistant-chat-identity.test.ts
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai __tests__/eval/assistant-chat-identity.test.ts

const logger = createScopedLogger("eval-assistant-chat-identity");
const evalReporter = createEvalReporter({
  evalName: "assistant-chat-identity",
});

const scenarios = [
  { name: "asked directly in English", request: "Who are you?" },
  {
    name: "asked in Spanish",
    request: "¿Quién eres y qué puedes hacer por mí?",
  },
];

describe.runIf(shouldRunEval)("Eval: assistant chat identity", () => {
  setupInboxWorkflowEval();

  describeEvalMatrix("assistant-chat identity", (model, emailAccount) => {
    for (const scenario of scenarios) {
      test(
        scenario.name,
        async () => {
          const trace = await captureAssistantChatTrace({
            emailAccount,
            messages: [{ role: "user", content: scenario.request }],
            logger,
          });

          const judgment = await judgeEvalOutput({
            input: scenario.request,
            output: trace.finalText,
            expected:
              "The assistant introduces itself as Cue, the user's email assistant.",
            criterion: {
              name: "Identifies as Cue",
              description:
                "The response identifies the assistant as Cue, the user's email assistant, in the language the user wrote in. It does not present itself under a different product or assistant name, and does not claim to be a general-purpose assistant unrelated to the user's email.",
            },
          });
          const tookWriteAction = hasAssistantWriteToolCalls(trace.toolCalls);
          const pass = judgment.pass && !tookWriteAction;

          evalReporter.record({
            testName: scenario.name,
            model: model.label,
            pass,
            actual: formatSemanticJudgeActual(trace.finalText, judgment),
          });

          expect(tookWriteAction).toBe(false);
          expect(judgment.pass, judgment.reasoning).toBe(true);
        },
        TIMEOUT,
      );
    }
  });

  afterAll(() => evalReporter.printReport());
});
