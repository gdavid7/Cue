import { ActionType } from "@/generated/prisma/enums";
import { ACTION_TYPE_LABELS } from "@/utils/action-display";

/** Actions that send mail as the user, so a run over past mail can't take them back. */
const SENDING_ACTIONS = new Set<ActionType>([
  ActionType.REPLY,
  ActionType.SEND_EMAIL,
  ActionType.FORWARD,
  ActionType.NOTIFY_SENDER,
]);
const DRAFT_ACTIONS = new Set<ActionType>([
  ActionType.DRAFT_EMAIL,
  ActionType.DRAFT_MESSAGING_CHANNEL,
]);

/**
 * What running the rules on past mail will do, in plain words, so the user
 * can confirm before a run that may archive, delete or send.
 */
export function summarizeBulkRun(
  rules: {
    name: string;
    enabled: boolean;
    actions: { type: ActionType }[];
  }[],
  { generateDraftReplies }: { generateDraftReplies: boolean },
) {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const types = new Set(
    enabledRules.flatMap((rule) =>
      rule.actions
        .map((action) => action.type)
        .filter((type) => generateDraftReplies || !DRAFT_ACTIONS.has(type)),
    ),
  );

  return {
    ruleCount: enabledRules.length,
    actions: [...types].map((type) => ACTION_TYPE_LABELS[type]),
    sendingRules: enabledRules
      .filter((rule) =>
        rule.actions.some((action) => SENDING_ACTIONS.has(action.type)),
      )
      .map((rule) => rule.name),
    deletes: types.has(ActionType.DELETE),
  };
}
