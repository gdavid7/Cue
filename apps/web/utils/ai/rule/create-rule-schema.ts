import { z } from "zod";
import { ActionType, LogicalOperator } from "@/generated/prisma/enums";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { isDefined } from "@/utils/types";
import {
  getOnlyIntegrationToolSpec,
  type IntegrationToolSpec,
} from "@/utils/mcp/tool-specs";
import {
  getAvailableActionsForRuleEditor,
  getExtraAvailableActionsForRuleEditor,
} from "@/utils/ai/rule/action-availability";
import { delayInMinutesLlmSchema } from "@/utils/actions/rule.validation";
import {
  AI_INSTRUCTIONS_PROMPT_DESCRIPTION,
  INVALID_STATIC_FROM_MESSAGE,
  isInvalidStaticFromValue,
  STATIC_FROM_CONDITION_DESCRIPTION,
} from "@/utils/ai/rule/rule-condition-descriptions";
import { isIntegrationActionGloballyEnabled } from "@/utils/integration-action";

const conditionalOperatorSchema = z
  .enum([LogicalOperator.AND, LogicalOperator.OR])
  .nullable()
  .describe(
    "The conditional operator to use. AND means all conditions must be true for the rule to match. OR means any condition can be true for the rule to match. This does not impact sub-conditions.",
  );

const optionalAiInstructionsSchema = z
  .string()
  .nullish()
  .transform((v) => (v?.trim() ? v : null));

const requiredAiInstructionsSchema = z.string().trim().min(1);

const optionalStaticFromSchema = z
  .string()
  .nullish()
  .transform((v) => (v?.trim() ? v : null))
  .refine((value) => !isInvalidStaticFromValue(value), {
    message: INVALID_STATIC_FROM_MESSAGE,
  });

const requiredStaticFromSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isInvalidStaticFromValue(value), {
    message: INVALID_STATIC_FROM_MESSAGE,
  });

const STATIC_TO_DESCRIPTION = "The to email address to match";
const STATIC_SUBJECT_DESCRIPTION =
  "Subject-line text to match. Use this when the user explicitly asks to match the email subject. If the user describes email content, topic, meaning, or general keyword matching without naming the subject line, use aiInstructions instead.";

const optionalStaticToSchema = z.string().nullish();
const requiredStaticToSchema = z.string().trim().min(1);
const optionalStaticSubjectSchema = z.string().nullish();
const requiredStaticSubjectSchema = z.string().trim().min(1);

const optionalStaticConditionSchema = z
  .object({
    from: optionalStaticFromSchema,
    to: optionalStaticToSchema,
    subject: optionalStaticSubjectSchema,
  })
  .nullish();

const semanticConditionSchema = z.object({
  conditionalOperator: conditionalOperatorSchema,
  aiInstructions: requiredAiInstructionsSchema,
  static: optionalStaticConditionSchema,
});

const staticFromConditionSchema = z.object({
  conditionalOperator: conditionalOperatorSchema,
  aiInstructions: optionalAiInstructionsSchema,
  static: z.object({
    from: requiredStaticFromSchema,
    to: optionalStaticToSchema,
    subject: optionalStaticSubjectSchema,
  }),
});

const staticToConditionSchema = z.object({
  conditionalOperator: conditionalOperatorSchema,
  aiInstructions: optionalAiInstructionsSchema,
  static: z.object({
    from: optionalStaticFromSchema,
    to: requiredStaticToSchema,
    subject: optionalStaticSubjectSchema,
  }),
});

const staticSubjectConditionSchema = z.object({
  conditionalOperator: conditionalOperatorSchema,
  aiInstructions: optionalAiInstructionsSchema,
  static: z.object({
    from: optionalStaticFromSchema,
    to: optionalStaticToSchema,
    subject: requiredStaticSubjectSchema,
  }),
});

const MISSING_CONDITION_MESSAGE =
  "The conditions to match. Include at least one semantic condition in aiInstructions or one static condition in from, to, or subject.";

// The model sees one flat condition object, with each field described once.
// Its checks report a bad condition in one message; the union of valid
// shapes, which would otherwise repeat every description in each variant of
// the tool schema, then builds the condition.
const modelFacingConditionSchema = z
  .object({
    conditionalOperator: conditionalOperatorSchema,
    aiInstructions: z
      .string()
      .nullish()
      .describe(AI_INSTRUCTIONS_PROMPT_DESCRIPTION),
    static: z
      .object({
        from: z.string().nullish().describe(STATIC_FROM_CONDITION_DESCRIPTION),
        to: z.string().nullish().describe(STATIC_TO_DESCRIPTION),
        subject: z.string().nullish().describe(STATIC_SUBJECT_DESCRIPTION),
      })
      .nullish()
      .describe(
        "The static conditions to match. If multiple static conditions are specified, the rule will match if ALL of the conditions match (AND operation)",
      ),
  })
  .superRefine((condition, ctx) => {
    const { static: staticCondition } = condition;
    const hasCondition = [
      condition.aiInstructions,
      staticCondition?.from,
      staticCondition?.to,
      staticCondition?.subject,
    ].some((value) => value?.trim());
    if (!hasCondition) {
      ctx.addIssue({ code: "custom", message: MISSING_CONDITION_MESSAGE });
    }
    if (isInvalidStaticFromValue(staticCondition?.from?.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["static", "from"],
        message: INVALID_STATIC_FROM_MESSAGE,
      });
    }
  })
  .describe(MISSING_CONDITION_MESSAGE);

const conditionSchema = modelFacingConditionSchema.pipe(
  z.union([
    semanticConditionSchema,
    staticFromConditionSchema,
    staticToConditionSchema,
    staticSubjectConditionSchema,
  ]),
);

export function getAvailableActions(provider: string) {
  const availableActions = getAvailableActionsForRuleEditor({
    provider,
  }).filter(isDefined);
  return availableActions as [ActionType, ...ActionType[]];
}

export const getExtraActions = ({
  existingActionTypes = [],
  integrationActionsEnabled,
}: {
  existingActionTypes?: ActionType[];
  integrationActionsEnabled: boolean;
}) =>
  getExtraAvailableActionsForRuleEditor({
    existingActionTypes,
    integrationActionsEnabled,
  });

export type RuleActionFields = {
  label?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  content?: string | null;
  webhookUrl?: string | null;
  folderName?: string | null;
};

export type RuleAction = {
  type: ActionType;
  fields?: RuleActionFields | null;
  delayInMinutes?: number | null;
};

// The model sees one flat action object: the type, every field described
// once, and which type needs which field. The per-type union, which would
// otherwise repeat every field description in each variant of the tool
// schema, still validates the input.
export const createRuleActionSchema = (
  provider: string,
  integrationActionsEnabled = isIntegrationActionGloballyEnabled(),
): z.ZodType<RuleAction> => {
  const allowedActionTypes = new Set([
    ...getAvailableActionsForRuleEditor({ provider }),
    ...getExtraAvailableActionsForRuleEditor({ integrationActionsEnabled }),
  ]);
  const integrationToolSpec = getOnlyIntegrationToolSpec();
  const optionalFieldsSchema = createOptionalActionFieldsSchema(provider);

  const variants: ActionVariant[] = [
    { type: ActionType.ARCHIVE, fields: optionalFieldsSchema },
    {
      type: ActionType.LABEL,
      fields: createRequiredFieldsSchema(provider, "label", "LABEL"),
      requiredField: "label",
    },
    { type: ActionType.MARK_READ, fields: optionalFieldsSchema },
    { type: ActionType.STAR, fields: optionalFieldsSchema },
    { type: ActionType.MARK_SPAM, fields: optionalFieldsSchema },
    { type: ActionType.DIGEST, fields: optionalFieldsSchema },
    ...(allowedActionTypes.has(ActionType.DRAFT_EMAIL)
      ? [{ type: ActionType.DRAFT_EMAIL, fields: optionalFieldsSchema }]
      : []),
    ...(allowedActionTypes.has(ActionType.REPLY)
      ? [{ type: ActionType.REPLY, fields: optionalFieldsSchema }]
      : []),
    ...(allowedActionTypes.has(ActionType.FORWARD)
      ? [
          {
            type: ActionType.FORWARD,
            fields: createRequiredFieldsSchema(provider, "to", "FORWARD"),
            requiredField: "to",
          },
        ]
      : []),
    ...(allowedActionTypes.has(ActionType.SEND_EMAIL)
      ? [
          {
            type: ActionType.SEND_EMAIL,
            fields: createRequiredFieldsSchema(provider, "to", "SEND_EMAIL"),
            requiredField: "to",
          },
        ]
      : []),
    ...(allowedActionTypes.has(ActionType.CALL_WEBHOOK)
      ? [
          {
            type: ActionType.CALL_WEBHOOK,
            fields: createRequiredFieldsSchema(
              provider,
              "webhookUrl",
              "CALL_WEBHOOK",
            ),
            requiredField: "webhookUrl",
          },
        ]
      : []),
    ...(allowedActionTypes.has(ActionType.MOVE_FOLDER)
      ? [
          {
            type: ActionType.MOVE_FOLDER,
            fields: createRequiredFolderFieldsSchema(provider),
            requiredField: "folderName",
          },
        ]
      : []),
    ...(allowedActionTypes.has(ActionType.INTEGRATION) && integrationToolSpec
      ? [
          {
            type: ActionType.INTEGRATION,
            fields: createIntegrationFieldsSchema(integrationToolSpec),
            description: integrationToolSpec.llmDescription,
          },
        ]
      : []),
  ];

  const hasIntegration = variants.some(
    (variant) => variant.type === ActionType.INTEGRATION,
  );
  const modelFacingSchema = z.object({
    type: z
      .enum(variants.map((variant) => variant.type) as [string, ...string[]])
      .describe(
        variants
          .map(
            (variant) =>
              `${variant.type}: ${variant.description ?? getActionTypeDescription(variant.type)}`,
          )
          .join("\n"),
      ),
    fields: z
      .object(
        createModelFacingFieldShape(
          provider,
          hasIntegration ? integrationToolSpec : undefined,
        ),
      )
      .nullish()
      .describe(describeRequiredFields(variants)),
    delayInMinutes: delayInMinutesLlmSchema,
  });

  const [first, second, ...rest] = variants.map((variant) =>
    z.object({
      type: z.literal(variant.type),
      fields: variant.fields,
      delayInMinutes: delayInMinutesLlmSchema,
    }),
  );

  // Keyed on type, a bad action reports only its own type's problem.
  return modelFacingSchema.pipe(
    z.discriminatedUnion("type", [
      first,
      second,
      ...rest,
    ]) as unknown as z.ZodType<RuleAction, z.output<typeof modelFacingSchema>>,
  ) as unknown as z.ZodType<RuleAction>;
};

export const createRuleSchema = (
  provider: string,
  integrationActionsEnabled = isIntegrationActionGloballyEnabled(),
) =>
  z.object({
    name: z
      .string()
      .describe(
        "A short, concise name for the rule (preferably a single word). For example: 'Marketing', 'Newsletters', 'Urgent', 'Receipts'. Avoid verbose names like 'Archive and label marketing emails'.",
      ),
    condition: conditionSchema,
    actions: z
      .array(createRuleActionSchema(provider, integrationActionsEnabled))
      .describe("The actions to take"),
  });

export type CreateRuleSchema = z.infer<ReturnType<typeof createRuleSchema>>;
export type CreateOrUpdateRuleSchema = CreateRuleSchema & {
  ruleId?: string;
};

type ActionVariant = {
  type: ActionType;
  fields: z.ZodTypeAny;
  requiredField?: string;
  description?: string;
};

function describeRequiredFields(variants: ActionVariant[]) {
  const required = variants.flatMap((variant) =>
    variant.requiredField
      ? [`${variant.type} requires ${variant.requiredField}`]
      : [],
  );

  return `Values for the action. Leave fields the action type does not use empty.${
    required.length ? ` ${required.join("; ")}.` : ""
  }`;
}

function getActionTypeDescription(type: ActionType) {
  switch (type) {
    case ActionType.DRAFT_EMAIL:
      return "Draft a reply to the matching inbound email without sending it. Use this for draft reply requests.";
    case ActionType.REPLY:
      return "Send a reply to the matching inbound email. Do not use this for draft reply requests.";
    case ActionType.SEND_EMAIL:
      return "Send a new outbound email. Do not use this for draft reply requests.";
    case ActionType.FORWARD:
      return "Forward the matching email.";
    case ActionType.LABEL:
      return "Apply a label to the matching email.";
    case ActionType.ARCHIVE:
      return "Archive the matching email.";
    case ActionType.MARK_READ:
      return "Mark the matching email as read.";
    case ActionType.STAR:
      return "Star the matching email.";
    case ActionType.MARK_SPAM:
      return "Mark the matching email as spam.";
    case ActionType.DIGEST:
      return "Include the matching email in a digest.";
    case ActionType.CALL_WEBHOOK:
      return "Call a webhook for the matching email. Only use this when the user explicitly asks for a webhook, external HTTP callback, or integration URL and provides the webhook URL. Do not use this for ordinary labeling, archiving, categorization, notifications, folders, or other email automation.";
    case ActionType.MOVE_FOLDER:
      return "Move the matching email to a folder.";
    default:
      return "Action type to apply to the matching email.";
  }
}

function createModelFacingFieldShape(
  provider: string,
  integrationToolSpec: IntegrationToolSpec | undefined,
) {
  const descriptions: Record<string, string> = {
    label: "The label to apply to the email",
    to: "The recipient email address. Use REPLY when responding to the triggering inbound email.",
    cc: "The cc email address to send the email to",
    bcc: "The bcc email address to send the email to",
    subject: "The subject of the email",
    content: "The content of the email",
    webhookUrl:
      "The webhook URL to call. Use CALL_WEBHOOK only when the user explicitly supplies a webhook URL.",
    ...(isMicrosoftProvider(provider) && {
      folderName: "The folder to move the email to",
    }),
  };

  for (const arg of integrationToolSpec?.args ?? []) {
    if (!arg.llmDescription) continue;
    const integrationDescription = `For INTEGRATION: ${arg.llmDescription}`;
    descriptions[arg.key] = descriptions[arg.key]
      ? `${descriptions[arg.key]}. ${integrationDescription}`
      : integrationDescription;
  }

  return Object.fromEntries(
    Object.entries(descriptions).map(([key, description]) => [
      key,
      z.string().nullish().describe(description),
    ]),
  );
}

function createOptionalActionFieldsSchema(provider: string) {
  return z.object(createActionFieldShape(provider)).nullish();
}

function createRequiredFieldsSchema(
  provider: string,
  field: "label" | "to" | "webhookUrl",
  actionType: string,
) {
  const message = `${actionType} requires fields.${field}.`;
  return z.object(
    {
      ...createActionFieldShape(provider),
      [field]: requiredStringField(message),
    },
    { error: message },
  );
}

function createRequiredFolderFieldsSchema(provider: string) {
  const fieldShape = createActionFieldShape(provider);

  if (!("folderName" in fieldShape)) {
    throw new Error("MOVE_FOLDER is only supported for Microsoft providers.");
  }

  const message = "MOVE_FOLDER requires fields.folderName.";
  return z.object(
    { ...fieldShape, folderName: requiredStringField(message) },
    { error: message },
  );
}

/** Accepts exactly the args the spec marks as LLM-settable. */
function createIntegrationFieldsSchema(spec: IntegrationToolSpec) {
  return z.object(
    Object.fromEntries(
      spec.args
        .filter((arg) => arg.llmDescription)
        .map((arg) => [arg.key, optionalStringField()]),
    ),
  );
}

function createActionFieldShape(provider: string) {
  return {
    label: optionalStringField(),
    to: optionalStringField(),
    cc: optionalStringField(),
    bcc: optionalStringField(),
    subject: optionalStringField(),
    content: optionalStringField(),
    webhookUrl: optionalStringField(),
    ...(isMicrosoftProvider(provider) && {
      folderName: optionalStringField(),
    }),
  };
}

function optionalStringField() {
  return z
    .string()
    .nullish()
    .transform((value) => value ?? null);
}

function requiredStringField(message: string) {
  return z
    .string({ error: message })
    .transform((value) => value.trim())
    .refine(Boolean, message);
}
