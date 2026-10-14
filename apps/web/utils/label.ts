import { messageVisibility } from "@/utils/gmail/constants";
import { getRuleLabel } from "@/utils/rule/consts";
import { SystemType } from "@/generated/prisma/enums";
import { BRAND_NAME } from "@/utils/branding";

export const PARENT_LABEL = BRAND_NAME;
// Mailboxes set up before the rename already hold these labels under the old
// parent, and keep using them so one mailbox never ends up with two copies.
const LEGACY_PARENT_LABEL = "Inbox Zero";

const blue = "#b6cff5";
const cyan = "#98d7e4";
const purple = "#e3d7ff";
const pink = "#fcdee8";
const red = "#f2b2a8";
const coral = "#ffc8af";
const orange = "#ffdeb5";
const yellow = "#fdedc1";
const green = "#b3efd3";
const rose = "#fbc8d9";
const gray = "#c2c2c2";

const LABEL_COLORS = [
  blue,
  cyan,
  purple,
  pink,
  red,
  coral,
  orange,
  yellow,
  green,
  rose,
] as const;

export const inboxZeroLabels = {
  archived: {
    name: `${PARENT_LABEL}/Archived`,
    color: blue,
    messageListVisibility: messageVisibility.hide,
  },
  marked_read: {
    name: `${PARENT_LABEL}/Read`,
    color: blue,
    messageListVisibility: messageVisibility.hide,
  },
  unsubscribed: {
    name: `${PARENT_LABEL}/Unsubscribed`,
    color: red,
    messageListVisibility: messageVisibility.hide,
  },
  processing: {
    name: `${PARENT_LABEL}/Processing`,
    color: yellow,
    messageListVisibility: messageVisibility.show,
  },
  processed: {
    name: `${PARENT_LABEL}/Processed`,
    color: gray,
    messageListVisibility: messageVisibility.hide,
  },
  assistant: {
    name: `${PARENT_LABEL}/Assistant`,
    color: purple,
    messageListVisibility: messageVisibility.show,
  },
} as const;

export type InboxZeroLabel = keyof typeof inboxZeroLabels;

/** Every name the label may have in a mailbox: the current one first. */
export function getInboxZeroLabelNames(key: InboxZeroLabel): string[] {
  const { name } = inboxZeroLabels[key];
  const legacyName = `${LEGACY_PARENT_LABEL}${name.slice(PARENT_LABEL.length)}`;
  return [...new Set([name, legacyName])];
}

export const FOLLOW_UP_LABEL = "Follow-up";

export function getLabelColor(name: string) {
  switch (name) {
    case getRuleLabel(SystemType.MARKETING):
      return red;
    case getRuleLabel(SystemType.NEWSLETTER):
      return coral;
    case getRuleLabel(SystemType.NOTIFICATION):
      return orange;
    case getRuleLabel(SystemType.RECEIPT):
      return yellow;
    case getRuleLabel(SystemType.TO_REPLY):
      return green;
    case getRuleLabel(SystemType.ACTIONED):
      return cyan;
    case getRuleLabel(SystemType.AWAITING_REPLY):
      return blue;
    case getRuleLabel(SystemType.CALENDAR):
      return purple;
    case getRuleLabel(SystemType.OTP):
      return cyan;
    case getRuleLabel(SystemType.COLD_EMAIL):
      return pink;
    case getRuleLabel(SystemType.FYI):
      return rose;
    case FOLLOW_UP_LABEL:
      return yellow;
    default:
      return getRandomLabelColor();
  }
}

function getRandomLabelColor() {
  return LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
}
