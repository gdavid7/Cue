import { env } from "@/env";
import { ActionType, type SystemType } from "@/generated/prisma/enums";
import { CONVERSATION_STATUS_TYPES } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";

/**
 * Every new mailbox starts with reply tracking on, whatever inbox style is
 * picked later, so Needs reply and Awaiting fill from the first email. Cue
 * sorts inside its own database and never labels or moves mail until the
 * person asks it to. The one action seeded is To Reply's draft, so "Auto draft
 * replies" starts on and suggested replies are ready from the first email.
 *
 * Shaped for a nested Prisma `rules: { create }` on a new EmailAccount, so it
 * only ever applies to mailboxes being created.
 */
export const INITIAL_REPLY_TRACKING_RULES = CONVERSATION_STATUS_TYPES.map(
  replyTrackingRuleData,
);

/**
 * One reply tracking rule as Cue creates it: enabled, never labelling or
 * moving mail, and for To Reply, drafting. Also used to add To Reply to an
 * older mailbox when its user turns drafting on.
 */
export function replyTrackingRuleData(systemType: SystemType) {
  const config = getRuleConfig(systemType);
  const draftsReplies =
    !!config.draftReply && !env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED;
  return {
    name: config.name,
    instructions: config.instructions,
    systemType,
    runOnThreads: config.runOnThreads,
    enabled: true,
    ...(draftsReplies && {
      actions: { create: [{ type: ActionType.DRAFT_EMAIL }] },
    }),
  };
}
