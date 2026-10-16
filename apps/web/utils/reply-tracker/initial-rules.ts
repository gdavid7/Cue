import { CONVERSATION_STATUS_TYPES } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";

/**
 * Every new mailbox starts with reply tracking on, whatever inbox style is
 * picked later, so Needs reply and Awaiting fill from the first email. The
 * rules have no actions: Cue sorts inside its own database and never labels,
 * moves or drafts in the mailbox until the person asks it to.
 *
 * Shaped for a nested Prisma `rules: { create }` on a new EmailAccount, so it
 * only ever applies to mailboxes being created.
 */
export const INITIAL_REPLY_TRACKING_RULES = CONVERSATION_STATUS_TYPES.map(
  (systemType) => {
    const config = getRuleConfig(systemType);
    return {
      name: config.name,
      instructions: config.instructions,
      systemType,
      runOnThreads: config.runOnThreads,
      enabled: true,
    };
  },
);
