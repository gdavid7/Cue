import { SystemType } from "@/generated/prisma/enums";

/**
 * Reply tracking is on when the To Reply rule is enabled, since that rule is
 * what puts mail in Needs reply. Select the account's rules with this, then
 * read them with `isReplyTrackingOn`.
 */
export const REPLY_TRACKING_RULES = {
  where: { systemType: SystemType.TO_REPLY },
  select: { enabled: true },
} as const;

export function isReplyTrackingOn(rules: { enabled: boolean }[] | undefined) {
  return rules?.some((rule) => rule.enabled) ?? false;
}
