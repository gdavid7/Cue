import { createHash } from "node:crypto";
import { type InferUITool, tool } from "ai";
import { z } from "zod";
import { LogicalOperator } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { filterNullProperties } from "@/utils";
import {
  createRuleActionSchema,
  type RuleAction,
} from "@/utils/ai/rule/create-rule-schema";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { isOutboundRuleAction } from "@/utils/rule/outbound-actions";
import {
  outboundActionsNeedChatConfirmation,
  partialUpdateRule,
  setRuleEnabled,
  updateRuleActions,
} from "@/utils/rule/rule";
import {
  AI_INSTRUCTIONS_PROMPT_DESCRIPTION,
  INVALID_STATIC_FROM_MESSAGE,
  isInvalidStaticFromValue,
  STATIC_FROM_CONDITION_DESCRIPTION,
} from "@/utils/ai/rule/rule-condition-descriptions";
import { hideToolErrorFromUser } from "../../tool-error-visibility";
import type {
  AssistantRuleSnapshot,
  RuleReadState,
} from "../../chat-rule-state";
import {
  buildProviderRuleActionFields,
  buildHiddenRuleNotFoundError,
  buildVisibleOrgManagedRuleError,
  loadRuleSnapshotAfterWrite,
  trackRuleToolCall,
  validateRuleWasReadRecently,
} from "./shared";

export const updateRuleTool = ({
  email,
  emailAccountId,
  provider,
  integrationActionsEnabled,
  logger,
  setRuleReadState,
  getRuleReadState,
  onRulesStateExposed,
  hasPendingRuleDeletion,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  integrationActionsEnabled?: boolean;
  logger: Logger;
  setRuleReadState?: (state: RuleReadState) => void;
  getRuleReadState?: () => RuleReadState | null;
  onRulesStateExposed?: (rulesRevision: number) => void;
  hasPendingRuleDeletion?: (ruleName: string) => boolean;
}) => {
  let updateQueue = Promise.resolve();

  return tool({
    description:
      "Update an existing rule after reading the user's current rules. Use this for direct requests to change rule name, enabled state, conditions, or actions; no capabilities lookup is needed before editing an existing rule. This is a patch: include only the fields being changed, and omitted fields are preserved. Use updates.name to rename a rule. Use updates.condition to change conditions; omit condition fields that should stay unchanged, and set a static field to null only when the user explicitly asks to clear it. Do not set aiInstructions to null to preserve instructions; omit it instead. Use clearAiInstructions only when the user explicitly asks to remove semantic instructions. Use DRAFT_EMAIL for draft reply actions; do not use SEND_EMAIL or REPLY when the user asks to draft. Never use this tool to add/remove a sender or domain from an existing category rule; use updateLearnedPatterns for recurring sender/domain includes and excludes instead. Direct requests to change existing rule behavior are already confirmed; do not create a replacement rule for edits.",
    inputSchema: z
      .object({
        ruleName: z.string().describe("The exact current name of the rule."),
        updates: z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe("The new rule name, when renaming the rule."),
            enabled: z
              .boolean()
              .optional()
              .describe(
                "Whether the rule should be enabled. Use false for pause/disable, true for enable/resume. For enabled-state-only requests, this should be the only field in updates.",
              ),
            condition: createPatchConditionSchema().optional(),
            actions: z
              .array(
                createRuleActionSchema(provider, integrationActionsEnabled),
              )
              .min(1, "Rules must have at least one action.")
              .optional()
              .describe(
                "The full replacement list of actions. Use only when the user explicitly asks to change actions/outcomes. Omit for condition-only, name-only, or enabled-state-only edits; omitted actions are preserved. To remove one action, include every action that should remain and omit the action being removed. Empty action lists are invalid.",
              ),
          })
          .refine((updates) => Object.keys(updates).length > 0, {
            message: "At least one update field is required.",
          }),
      })
      .describe("Patch update for an existing rule."),
    execute: async ({ ruleName, updates }) => {
      const previousUpdate = updateQueue;
      let releaseNextUpdate!: () => void;
      updateQueue = new Promise<void>((resolve) => {
        releaseNextUpdate = resolve;
      });

      await previousUpdate;
      trackRuleToolCall({ tool: "update_rule", email, logger });
      try {
        const readValidationError = validateRuleWasReadRecently({
          ruleName,
          getRuleReadState,
        });

        if (readValidationError) {
          return hideToolErrorFromUser({
            success: false,
            error: readValidationError,
          });
        }

        const rule = await prisma.rule.findUnique({
          where: { name_emailAccountId: { name: ruleName, emailAccountId } },
          select: {
            id: true,
            name: true,
            enabled: true,
            updatedAt: true,
            organizationRuleId: true,
            instructions: true,
            from: true,
            to: true,
            subject: true,
            conditionalOperator: true,
            emailAccount: {
              select: {
                rulesRevision: true,
              },
            },
            actions: {
              select: {
                type: true,
                content: true,
                label: true,
                to: true,
                cc: true,
                bcc: true,
                subject: true,
                url: true,
                folderName: true,
                delayInMinutes: true,
              },
            },
          },
        });

        if (!rule) {
          return buildHiddenRuleNotFoundError();
        }

        if (rule.organizationRuleId) {
          return buildVisibleOrgManagedRuleError();
        }

        const staleReadError = validateRuleWasReadRecently({
          ruleName,
          getRuleReadState,
          currentRulesRevision: rule.emailAccount.rulesRevision,
          currentRuleUpdatedAt: rule.updatedAt,
        });
        if (staleReadError) {
          return hideToolErrorFromUser({
            success: false,
            error: staleReadError,
          });
        }

        if (hasPendingRuleDeletion?.(rule.name)) {
          return hideToolErrorFromUser({
            success: false,
            error:
              "Deletion is already pending for this rule. Do not update or disable the same rule after requesting deletion.",
          });
        }

        const originalConditions = {
          aiInstructions: rule.instructions,
          static: filterNullProperties({
            from: rule.from,
            to: rule.to,
            subject: rule.subject,
          }),
          conditionalOperator: rule.conditionalOperator,
        };
        const originalActions = rule.actions.map((action) => ({
          type: action.type,
          fields: filterNullProperties(
            buildProviderRuleActionFields({
              provider,
              fields: {
                label: action.label,
                content: action.content,
                to: action.to,
                cc: action.cc,
                bcc: action.bcc,
                subject: action.subject,
                webhookUrl: action.url,
                folderName: action.folderName,
              },
            }),
          ),
          delayInMinutes: action.delayInMinutes,
        }));
        const requestedChangesAlreadyMatchRule = !ruleUpdateHasChanges({
          updates,
          rule,
          originalActions,
        });
        const effectiveUpdates = normalizeRuleUpdates({
          updates,
          rule,
          originalActions,
        });
        if (requestedChangesAlreadyMatchRule) {
          const snapshot = await loadRuleSnapshotAfterWrite({
            emailAccountId,
            logger,
            setRuleReadState,
            onRulesStateExposed,
          });
          const currentRule = snapshot?.rules.find(
            (snapshotRule) => snapshotRule.name === rule.name,
          );

          return {
            success: true,
            alreadyApplied: true,
            message:
              "The requested update already matches the current rule, so no write was applied.",
            ruleId: rule.id,
            originalName: rule.name,
            updatedName: rule.name,
            originalEnabled: rule.enabled,
            updatedEnabled: rule.enabled,
            originalConditions,
            originalActions,
            currentRule,
          };
        }

        const { needsConfirmation, riskMessages } =
          outboundActionsNeedChatConfirmation(
            buildRiskCheckInput({
              rule,
              effectiveUpdates,
              originalActions,
              provider,
            }),
          );
        if (needsConfirmation) {
          return {
            success: true,
            actionType: "update_rule" as const,
            requiresConfirmation: true as const,
            confirmationState: "pending" as const,
            riskMessages,
            ruleId: rule.id,
            ruleFingerprint: getRuleFingerprint(rule),
            originalName: rule.name,
            updatedName: effectiveUpdates.name ?? rule.name,
            originalEnabled: rule.enabled,
            updatedEnabled: effectiveUpdates.enabled ?? rule.enabled,
            originalConditions,
            updatedConditions: effectiveUpdates.condition,
            originalActions,
            updatedActions: effectiveUpdates.actions,
          };
        }

        await applyRuleUpdate({
          ruleId: rule.id,
          currentEnabled: rule.enabled,
          emailAccountId,
          provider,
          updates: effectiveUpdates,
          logger,
        });

        const snapshot = await loadRuleSnapshotAfterWrite({
          emailAccountId,
          logger,
          setRuleReadState,
          onRulesStateExposed,
        });
        const currentRule = snapshot?.rules.find(
          (snapshotRule) =>
            snapshotRule.name === (effectiveUpdates.name ?? rule.name),
        );

        return {
          success: true,
          ruleId: rule.id,
          originalName: rule.name,
          updatedName: effectiveUpdates.name ?? rule.name,
          originalEnabled: rule.enabled,
          updatedEnabled: effectiveUpdates.enabled ?? rule.enabled,
          originalConditions,
          updatedConditions: effectiveUpdates.condition,
          originalActions,
          updatedActions: effectiveUpdates.actions,
          currentRule,
        };
      } catch (error) {
        logger.error("Failed to update rule", { error, ruleName });

        if (isDuplicateError(error, "name")) {
          return {
            success: false,
            error:
              "No rule was updated. Another rule already uses that name. Ask the user for a different name.",
          };
        }

        return {
          success: false,
          error: "Failed to update rule",
        };
      } finally {
        releaseNextUpdate();
      }
    },
  });
};

export type UpdateRuleTool = InferUITool<ReturnType<typeof updateRuleTool>>;

export const RULE_FINGERPRINT_SELECT = {
  name: true,
  enabled: true,
  instructions: true,
  from: true,
  to: true,
  subject: true,
  conditionalOperator: true,
  actions: {
    select: {
      type: true,
      content: true,
      label: true,
      to: true,
      cc: true,
      bcc: true,
      subject: true,
      url: true,
      folderName: true,
      delayInMinutes: true,
    },
  },
} as const;

/**
 * What the rule does now, as one value, so a confirmation can tell that the
 * rule it was shown is still the rule it would change. Covers action edits
 * that may not touch the rule's own updatedAt.
 */
export function getRuleFingerprint(rule: {
  name: string;
  enabled: boolean;
  instructions: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  conditionalOperator: string | null;
  actions: Array<Record<string, unknown> & { type: string }>;
}) {
  const actions = rule.actions
    .map((action) =>
      JSON.stringify(
        Object.keys(RULE_FINGERPRINT_SELECT.actions.select).map((key) => [
          key,
          action[key] ?? null,
        ]),
      ),
    )
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify([
        rule.name,
        rule.enabled,
        rule.instructions,
        rule.from,
        rule.to,
        rule.subject,
        rule.conditionalOperator,
        actions,
      ]),
    )
    .digest("hex");
}

export async function applyRuleUpdate({
  ruleId,
  currentEnabled,
  emailAccountId,
  provider,
  updates,
  logger,
}: {
  ruleId: string;
  currentEnabled: boolean;
  emailAccountId: string;
  provider: string;
  updates: RuleUpdatePatch;
  logger: Logger;
}) {
  if (updates.name || updates.condition) {
    await partialUpdateRule({
      ruleId,
      emailAccountId,
      data: {
        ...(updates.name && { name: updates.name }),
        ...(updates.condition && buildConditionUpdateData(updates.condition)),
      },
    });
  }

  if (updates.actions) {
    await updateRuleActions({
      ruleId,
      actions: updates.actions.map((action) => ({
        type: action.type,
        fields: buildProviderRuleActionFields({
          provider,
          fields: action.fields ?? {},
        }),
        delayInMinutes: action.delayInMinutes ?? null,
      })),
      provider,
      emailAccountId,
      logger,
    });
  }

  if (updates.enabled !== undefined && updates.enabled !== currentEnabled) {
    await setRuleEnabled({
      ruleId,
      emailAccountId,
      enabled: updates.enabled,
    });
  }
}

export type UpdateRuleOutput = {
  success: boolean;
  actionType?: "update_rule";
  requiresConfirmation?: true;
  confirmationState?: "pending" | "processing" | "confirmed";
  riskMessages?: string[];
  ruleFingerprint?: string;
  alreadyApplied?: boolean;
  message?: string;
  ruleId?: string;
  error?: string;
  originalName?: string;
  updatedName?: string;
  originalEnabled?: boolean;
  updatedEnabled?: boolean;
  originalConditions?: {
    aiInstructions: string | null;
    static?: Record<string, string | null>;
    conditionalOperator: string | null;
  };
  updatedConditions?: PatchCondition;
  originalActions?: Array<{
    type: string;
    fields: Record<string, string | null>;
    delayInMinutes?: number | null;
  }>;
  updatedActions?: RuleAction[];
  currentRule?: AssistantRuleSnapshot["rules"][number];
};

type PatchCondition = {
  aiInstructions?: string;
  // boolean (not literal true): Gemini rejects boolean constants in tool JSON Schema enums
  clearAiInstructions?: boolean;
  static?: {
    from?: string | null;
    to?: string | null;
    subject?: string | null;
  } | null;
  conditionalOperator?: LogicalOperator | null;
};

export type RuleUpdatePatch = {
  name?: string;
  enabled?: boolean;
  condition?: PatchCondition;
  actions?: RuleAction[];
};

function buildRiskCheckInput({
  rule,
  effectiveUpdates,
  originalActions,
  provider,
}: {
  rule: {
    conditionalOperator: LogicalOperator | null;
    enabled: boolean;
    from: string | null;
    instructions: string | null;
    subject: string | null;
    to: string | null;
  };
  effectiveUpdates: RuleUpdatePatch;
  originalActions: NonNullable<UpdateRuleOutput["originalActions"]>;
  provider: string;
}) {
  const originalActionKeys = new Set(
    originalActions.map((action) =>
      JSON.stringify(normalizeActionForComparison(action)),
    ),
  );
  const resultingActions: RuleAction[] =
    effectiveUpdates.actions ??
    originalActions.map((action) => ({
      ...action,
      type: action.type as RuleAction["type"],
    }));
  // Turning a rule back on, or changing which mail it matches, changes where
  // its existing outbound actions send mail, so those count as changed too.
  const reachChanges =
    !!effectiveUpdates.condition ||
    (effectiveUpdates.enabled === true && !rule.enabled);
  const changedActions = resultingActions.filter(
    (action) =>
      (reachChanges && isOutboundRuleAction(action.type)) ||
      !originalActionKeys.has(
        JSON.stringify(normalizeActionForComparison(action)),
      ),
  );

  return {
    actions: changedActions.map((action) => ({
      type: action.type,
      fields: buildProviderRuleActionFields({
        provider,
        fields: action.fields ?? {},
      }),
      delayInMinutes: action.delayInMinutes ?? null,
    })),
    conditions: {
      instructions: rule.instructions,
      from: rule.from,
      to: rule.to,
      subject: rule.subject,
      conditionalOperator: rule.conditionalOperator ?? undefined,
      ...(effectiveUpdates.condition &&
        buildConditionUpdateData(effectiveUpdates.condition)),
    },
  };
}

function ruleUpdateHasChanges({
  updates,
  rule,
  originalActions,
}: {
  updates: RuleUpdatePatch;
  rule: {
    conditionalOperator: LogicalOperator | null;
    enabled: boolean;
    from: string | null;
    instructions: string | null;
    name: string;
    subject: string | null;
    to: string | null;
  };
  originalActions: NonNullable<UpdateRuleOutput["originalActions"]>;
}) {
  if (updates.name !== undefined && updates.name !== rule.name) return true;
  if (updates.enabled !== undefined && updates.enabled !== rule.enabled) {
    return true;
  }
  if (updates.condition && conditionChangesRule(updates.condition, rule)) {
    return true;
  }
  if (
    updates.actions &&
    !actionsLookCopiedFromRule(updates.actions, originalActions)
  ) {
    return true;
  }

  return false;
}

function conditionChangesRule(
  condition: PatchCondition,
  rule: {
    conditionalOperator: LogicalOperator | null;
    from: string | null;
    instructions: string | null;
    subject: string | null;
    to: string | null;
  },
) {
  if ("aiInstructions" in condition) {
    if (condition.aiInstructions !== rule.instructions) return true;
  }
  if (
    condition.clearAiInstructions &&
    !("aiInstructions" in condition) &&
    rule.instructions !== null
  ) {
    return true;
  }
  if (
    "conditionalOperator" in condition &&
    condition.conditionalOperator !== rule.conditionalOperator
  ) {
    return true;
  }
  if ("static" in condition) {
    return !staticLooksCopiedFromRule(condition.static, rule);
  }

  return false;
}

function normalizeRuleUpdates({
  updates,
  rule,
  originalActions,
}: {
  updates: RuleUpdatePatch;
  rule: {
    conditionalOperator: LogicalOperator | null;
    from: string | null;
    instructions: string | null;
    name: string;
    subject: string | null;
    to: string | null;
  };
  originalActions: NonNullable<UpdateRuleOutput["originalActions"]>;
}): RuleUpdatePatch {
  const normalized = { ...updates };
  if (normalized.name === rule.name) normalized.name = undefined;
  if (
    normalized.condition &&
    conditionLooksCopiedFromRule(normalized.condition, rule)
  ) {
    normalized.condition = undefined;
  }
  if (
    normalized.actions &&
    actionsLookCopiedFromRule(normalized.actions, originalActions)
  ) {
    normalized.actions = undefined;
  }

  return normalized;
}

function conditionLooksCopiedFromRule(
  condition: PatchCondition,
  rule: {
    conditionalOperator: LogicalOperator | null;
    from: string | null;
    instructions: string | null;
    subject: string | null;
    to: string | null;
  },
) {
  return !conditionChangesRule(condition, rule);
}

function staticLooksCopiedFromRule(
  staticCondition: PatchCondition["static"] | undefined,
  rule: { from: string | null; subject: string | null; to: string | null },
) {
  if (staticCondition === undefined) return true;
  if (staticCondition === null) {
    return rule.from === null && rule.to === null && rule.subject === null;
  }

  return (
    (!("from" in staticCondition) ||
      normalizeNullableString(staticCondition.from) === rule.from) &&
    (!("to" in staticCondition) ||
      normalizeNullableString(staticCondition.to) === rule.to) &&
    (!("subject" in staticCondition) ||
      normalizeNullableString(staticCondition.subject) === rule.subject)
  );
}

function actionsLookCopiedFromRule(
  actions: RuleAction[],
  originalActions: NonNullable<UpdateRuleOutput["originalActions"]>,
) {
  return (
    JSON.stringify(actions.map(normalizeActionForComparison)) ===
    JSON.stringify(originalActions.map(normalizeActionForComparison))
  );
}

function normalizeActionForComparison(action: {
  delayInMinutes?: number | null;
  fields?: Record<string, string | null> | null;
  type: string;
}) {
  return {
    type: action.type,
    delayInMinutes: action.delayInMinutes ?? null,
    fields: Object.fromEntries(
      Object.entries(action.fields ?? {})
        .map(([key, value]) => [key, normalizeNullableString(value)] as const)
        .filter(([, value]) => value !== null)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined || value === null || value === "null") return null;
  return value;
}

function createPatchConditionSchema() {
  return z
    .object({
      aiInstructions: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          `${AI_INSTRUCTIONS_PROMPT_DESCRIPTION} Omit this field to preserve existing instructions.`,
        ),
      clearAiInstructions: z
        .boolean()
        .optional()
        .describe(
          "Set to true only when the user explicitly asks to remove the semantic AI instructions from this rule.",
        ),
      static: z
        .object({
          from: z
            .string()
            .transform((v) => (v?.trim() ? v : null))
            .nullable()
            .optional()
            .refine((value) => !isInvalidStaticFromValue(value), {
              message: INVALID_STATIC_FROM_MESSAGE,
            })
            .describe(STATIC_FROM_CONDITION_DESCRIPTION),
          to: z.string().nullish(),
          subject: z.string().nullish(),
        })
        .nullish()
        .describe(
          "Static condition fields to patch. Omit fields to preserve them. To clear one field, pass an object with only that field set to null (e.g. { from: null } to remove just the sender restriction). Setting the whole static object to null clears every static condition; do that only when the user asks to remove them all.",
        ),
      conditionalOperator: z
        .enum([LogicalOperator.AND, LogicalOperator.OR])
        .nullish(),
    })
    .describe(
      "Condition patch. Omitted condition fields are preserved; null clears fields only when explicit.",
    );
}

function buildConditionUpdateData(condition: PatchCondition) {
  const data: {
    instructions?: string | null;
    from?: string | null;
    to?: string | null;
    subject?: string | null;
    conditionalOperator?: LogicalOperator;
  } = {};

  if (condition.aiInstructions !== undefined) {
    data.instructions = condition.aiInstructions;
  } else if (condition.clearAiInstructions) {
    data.instructions = null;
  }

  if (condition.conditionalOperator) {
    data.conditionalOperator = condition.conditionalOperator;
  }

  if ("static" in condition) {
    if (condition.static === null) {
      data.from = null;
      data.to = null;
      data.subject = null;
    } else if (condition.static) {
      if ("from" in condition.static) data.from = condition.static.from ?? null;
      if ("to" in condition.static) data.to = condition.static.to ?? null;
      if ("subject" in condition.static) {
        data.subject = condition.static.subject ?? null;
      }
    }
  }

  return data;
}
