import { env } from "@/env";
import { ActionType } from "@/generated/prisma/enums";

type ToReplyRule =
  | { enabled: boolean; actions: { type: ActionType }[] }
  | null
  | undefined;

/**
 * Where the account stands on "Auto draft replies":
 * - "on": the To Reply rule is enabled and drafts.
 * - "off": the user turned it off. The settings toggle disables the whole To
 *   Reply rule, so a disabled rule is that choice (or the user switching To
 *   Reply off altogether, which is a stronger no).
 * - "unset": never chosen. Mailboxes created before drafting became the
 *   default have no To Reply rule, or an enabled one without a draft action.
 */
export type DraftRepliesSetting = "on" | "off" | "unset";

export function getDraftRepliesSetting(
  toReplyRule: ToReplyRule,
): DraftRepliesSetting {
  if (env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED) return "off";
  if (!toReplyRule) return "unset";
  if (!toReplyRule.enabled) return "off";
  return toReplyRule.actions.some(
    (action) => action.type === ActionType.DRAFT_EMAIL,
  )
    ? "on"
    : "unset";
}

/**
 * Whether "Auto draft replies" is on, so Cue drafts without being asked. The
 * settings toggle, rule drafting and the reader's pre-filled reply all follow
 * this one switch.
 */
export function isDraftRepliesEnabled(toReplyRule: ToReplyRule) {
  return getDraftRepliesSetting(toReplyRule) === "on";
}

/**
 * Whether Cue may write a reply the user asks for. Only an explicit "off"
 * stops it: that choice means no AI-written reply at all.
 */
export function canWriteRequestedReplies(setting: DraftRepliesSetting) {
  return setting !== "off";
}
