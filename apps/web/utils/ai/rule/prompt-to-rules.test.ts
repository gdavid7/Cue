import { asSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { ActionType } from "@/generated/prisma/enums";
import { aiPromptToRules } from "@/utils/ai/rule/prompt-to-rules";
import { SafeError } from "@/utils/error";

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => mockGenerateObject,
}));
vi.mock("@/utils/llms/use-cases", () => ({
  getModelForUseCase: () => ({}),
  LlmUseCase: { PromptToRules: "prompt-to-rules" },
}));
vi.mock("@/utils/integration-action.server", () => ({
  isIntegrationActionEnabledForUserId: async () => false,
}));

const validRule = {
  name: "Receipts",
  condition: {
    conditionalOperator: null,
    aiInstructions: "Receipts and invoices",
    static: null,
  },
  actions: [{ type: ActionType.LABEL, fields: { label: "Receipts" } }],
};
const labelWithoutName = {
  ...validRule,
  name: "Newsletters",
  actions: [{ type: ActionType.LABEL, fields: {} }],
};

describe("aiPromptToRules", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("rejects the whole request with a 4xx error when any rule is invalid", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { rules: [validRule, labelWithoutName] },
    });

    const error = await aiPromptToRules({
      emailAccount: getEmailAccount(),
      promptFile: "Label receipts. Label newsletters.",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as SafeError).statusCode).toBe(422);
    expect((error as SafeError).safeMessage).toContain(
      "LABEL requires fields.label.",
    );
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("rejects a response without a rules list instead of returning none", async () => {
    mockGenerateObject.mockResolvedValue({ object: {} });

    await expect(
      aiPromptToRules({
        emailAccount: getEmailAccount(),
        promptFile: "Label receipts.",
      }),
    ).rejects.toBeInstanceOf(SafeError);
  });

  it("rejects an empty response with a 4xx error", async () => {
    mockGenerateObject.mockResolvedValue({
      object: null,
      finishReason: "stop",
      response: { modelId: "model" },
      usage: { totalTokens: 1 },
    });

    const error = await aiPromptToRules({
      emailAccount: getEmailAccount(),
      promptFile: "Label receipts.",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as SafeError).statusCode).toBe(422);
  });

  it("returns every rule when all are valid", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { rules: [validRule, { ...validRule, name: "Invoices" }] },
    });

    const rules = await aiPromptToRules({
      emailAccount: getEmailAccount(),
      promptFile: "Label receipts and invoices.",
    });

    expect(rules.map((rule) => rule.name)).toEqual(["Receipts", "Invoices"]);
  });

  it("does not ask the model layer to validate, so it never retries a schema failure", async () => {
    mockGenerateObject.mockResolvedValue({ object: { rules: [validRule] } });

    await aiPromptToRules({
      emailAccount: getEmailAccount(),
      promptFile: "Label receipts.",
    });

    const schema = asSchema(mockGenerateObject.mock.calls[0][0].schema);
    const jsonSchema = (await schema.jsonSchema) as {
      properties: { rules: { items: { properties: object } } };
    };
    expect(Object.keys(jsonSchema.properties.rules.items.properties)).toEqual([
      "name",
      "condition",
      "actions",
    ]);
    expect(schema.validate).toBeUndefined();
  });

  it("explains the problem when no generated rule is valid", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { rules: [labelWithoutName] },
    });

    await expect(
      aiPromptToRules({
        emailAccount: getEmailAccount(),
        promptFile: "Label newsletters.",
      }),
    ).rejects.toThrow("LABEL requires fields.label.");
  });
});
