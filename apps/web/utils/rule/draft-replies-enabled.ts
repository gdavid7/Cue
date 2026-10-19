import { env } from "@/env";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { isDraftReplyActionType } from "@/utils/actions/draft-reply";
import type { RuleWithActions } from "@/utils/types";

type ToReplyRule =
  | { enabled: boolean; actions: { type: ActionType }[] }
  | null
  | undefined;

/**
 * Where the account stands on "Auto draft replies". It is on unless the user
 * turned it off: the settings toggle disables the whole To Reply rule, so a
 * disabled rule is that choice (or the user switching To Reply off
 * altogether, which is a stronger no).
 *
 * Never having chosen counts as on. Mailboxes set up before drafting became
 * the default have no To Reply rule, or an enabled one without a draft
 * action; they get suggestions like a new mailbox does. Every surface reads
 * this one answer: the rules' draft (via `withDefaultDraftReply`), the
 * reader, pre-drafts and the toggle.
 */
export type DraftRepliesSetting = "on" | "off";

export function getDraftRepliesSetting(
  toReplyRule: ToReplyRule,
): DraftRepliesSetting {
  if (env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED) return "off";
  if (toReplyRule && !toReplyRule.enabled) return "off";
  return "on";
}

/** Whether Cue may write a reply at all, asked for or not. */
export function canWriteRequestedReplies(setting: DraftRepliesSetting) {
  return setting === "on";
}

/**
 * The To Reply rule as the rules run it: one that never chose drafts all the
 * same, so it gets the draft action it would have been created with. Only in
 * memory, so the user's own choice is still the only thing ever saved.
 */
export function withDefaultDraftReply(rule: RuleWithActions): RuleWithActions {
  if (
    rule.systemType !== SystemType.TO_REPLY ||
    getDraftRepliesSetting(rule) !== "on" ||
    // A rule that already drafts, to the mailbox or a messaging channel.
    rule.actions.some((action) => isDraftReplyActionType(action.type))
  ) {
    return rule;
  }
  return {
    ...rule,
    actions: [
      ...rule.actions,
      {
        id: `default-draft-${rule.id}`,
        type: ActionType.DRAFT_EMAIL,
        ruleId: rule.id,
        emailAccountId: rule.emailAccountId,
        messagingChannelId: null,
        messagingChannelEmailAccountId: null,
        label: null,
        labelId: null,
        subject: null,
        content: null,
        to: null,
        cc: null,
        bcc: null,
        url: null,
        folderName: null,
        folderId: null,
        delayInMinutes: null,
        staticAttachments: null,
        integrationName: null,
        integrationToolName: null,
        integrationArgs: null,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      },
    ],
  };
}
