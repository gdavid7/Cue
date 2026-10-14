import { env } from "@/env";
import { ActionType } from "@/generated/prisma/enums";

/**
 * Whether "Auto draft replies" is on: the To Reply rule is enabled and drafts.
 * The settings toggle, rule drafting and the reader's pre-filled reply all
 * follow this one switch, so turning it off stops every AI-written reply.
 */
export function isDraftRepliesEnabled(
  toReplyRule:
    | { enabled: boolean; actions: { type: ActionType }[] }
    | null
    | undefined,
) {
  if (env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED) return false;
  if (!toReplyRule?.enabled) return false;
  return toReplyRule.actions.some(
    (action) => action.type === ActionType.DRAFT_EMAIL,
  );
}
