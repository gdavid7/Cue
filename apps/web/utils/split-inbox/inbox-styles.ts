import { MailSplitFilterKind } from "@/generated/prisma/enums";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { GmailLabel } from "@/utils/gmail/label";
import type { MailSplitFilterDraft } from "@/utils/split-inbox/split-filters";
import type { MailSplitFilter } from "@/utils/split-inbox/split-query";

export const INBOX_STYLES = ["tabs", "focused-other", "one-inbox"] as const;

export type InboxStyle = (typeof INBOX_STYLES)[number];

type InboxStyleSplit = {
  name: string;
  filters: (MailSplitFilter & MailSplitFilterDraft)[];
};

/**
 * The tabs each familiar inbox shows, as splits over the real mailbox. They are
 * views only: choosing one never moves or relabels mail.
 */
const SPLITS_BY_STYLE: Record<InboxStyle, InboxStyleSplit[]> = {
  tabs: [
    categorySplit("Primary", GmailLabel.PERSONAL),
    categorySplit("Promotions", GmailLabel.PROMOTIONS),
    categorySplit("Social", GmailLabel.SOCIAL),
    categorySplit("Updates", GmailLabel.UPDATES),
  ],
  "focused-other": [
    categorySplit("Focused", "focused"),
    categorySplit("Other", "other"),
  ],
  "one-inbox": [],
};

/**
 * Only the styles the provider can actually filter by: Gmail categories don't
 * exist in Outlook, and Gmail has no Focused/Other classification.
 */
export function getInboxStyleOptions(provider: string): InboxStyle[] {
  if (isGoogleProvider(provider)) return ["tabs", "one-inbox"];
  if (isMicrosoftProvider(provider)) return ["focused-other", "one-inbox"];
  return [];
}

/** Each provider's out-of-the-box inbox, since Cue can't read which one is on. */
export function getDefaultInboxStyle(provider: string): InboxStyle {
  return getInboxStyleOptions(provider)[0] ?? "one-inbox";
}

export function getInboxStyleSplits(style: InboxStyle): InboxStyleSplit[] {
  return SPLITS_BY_STYLE[style];
}

/** The choice is per mailbox, but stored with the user's other dismissed hints. */
export function getInboxStyleHintId(emailAccountId: string) {
  return `inbox-style:${emailAccountId}`;
}

/**
 * Puts the style's tabs right after All, where they sit in the inbox the person
 * is used to, and keeps every other split in its current order.
 */
export function orderSplitsForInboxStyle(
  splits: { id: string; filters: unknown[] }[],
  styleSplitIds: string[],
) {
  const styleIds = new Set(styleSplitIds);
  const all = splits.filter((split) => split.filters.length === 0);
  const rest = splits.filter(
    (split) => split.filters.length > 0 && !styleIds.has(split.id),
  );
  return [
    ...all.map((split) => split.id),
    ...styleSplitIds,
    ...rest.map((split) => split.id),
  ];
}

function categorySplit(name: string, category: string): InboxStyleSplit {
  return {
    name,
    filters: [{ kind: MailSplitFilterKind.CATEGORY, value: category }],
  };
}
