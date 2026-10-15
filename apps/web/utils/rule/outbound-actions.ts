import { ActionType } from "@/generated/prisma/enums";

/** Actions that send mail or email data somewhere outside the inbox. */
export function isOutboundRuleAction(type: string) {
  return isOutboundEmailAction(type) || type === ActionType.CALL_WEBHOOK;
}

export function isOutboundEmailAction(type: string) {
  return (
    type === ActionType.FORWARD ||
    type === ActionType.SEND_EMAIL ||
    type === ActionType.REPLY
  );
}
