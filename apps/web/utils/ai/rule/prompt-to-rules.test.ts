import { asSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { ActionType } from "@/generated/prisma/enums";
import { aiPromptToRules } from "@/utils/ai/rule/prompt-to-rules";

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

  it("keeps the valid rules when one generated rule is invalid", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { rules: [validRule, labelWithoutName] },
    });

    const rules = await aiPromptToRules({
      emailAccount: getEmailAccount(),
      promptFile: "Label receipts. Label newsletters.",
    });

    expect(rules.map((rule) => rule.name)).toEqual(["Receipts"]);
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
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
