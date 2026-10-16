import { isAutomatedAddress } from "@cue/context";
import { SystemType } from "@/generated/prisma/enums";
import type { EmailLabels } from "@/providers/email-label-types";
import { extractEmailAddress } from "@/utils/email";
import type { EmailInsight } from "@/utils/inbox-insights/extract-insight";
import { getRuleLabel } from "@/utils/rule/consts";

/** Mail between people: the categories Cue's conversation tracking assigns. */
const CONVERSATION_TYPES: SystemType[] = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
];

/** Bulk and machine mail, where a summary costs a model call for little. */
const AUTOMATED_TYPES: SystemType[] = [
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
  SystemType.RECEIPT,
  SystemType.CALENDAR,
  SystemType.NOTIFICATION,
  SystemType.OTP,
];

const SYSTEM_TYPE_BY_LABEL = new Map(
  [...CONVERSATION_TYPES, ...AUTOMATED_TYPES].map((type) => [
    getRuleLabel(type).toLowerCase(),
    type,
  ]),
);

// Skipped and failed runs didn't sort anything.
const SORTED_STATUSES = new Set(["APPLIED", "APPLYING"]);

export type CueStripVisibility = "show" | "hide" | "pending";

/**
 * The categories Cue has put a conversation in, from the labels on its
 * messages and from the rules it ran, which also cover accounts where Cue
 * sorts without labelling the mailbox.
 */
export function getThreadCategories({
  messages,
  userLabels,
  plans,
}: {
  messages: { labelIds?: string[] | null }[];
  userLabels: EmailLabels;
  plans: { status: string; rule: { systemType: string | null } | null }[];
}): Set<string> {
  const categories = new Set<string>();
  for (const message of messages) {
    for (const id of message.labelIds ?? []) {
      const name = userLabels[id]?.name.toLowerCase();
      const type = name ? SYSTEM_TYPE_BY_LABEL.get(name) : undefined;
      if (type) categories.add(type);
    }
  }
  for (const plan of plans) {
    if (plan.rule?.systemType && SORTED_STATUSES.has(plan.status))
      categories.add(plan.rule.systemType);
  }
  return categories;
}

/**
 * Whether the reader shows the Cue strip. Only conversations with people get
 * one: a summary of a newsletter or receipt costs a model call and is the
 * likeliest to be wrong. A conversation category wins over a bulk one, since
 * a mailing someone answered has become a conversation. Without a category,
 * it needs a newest message from a person, and then Cue's note on it decides:
 * it shows when the email asks the user to reply or act.
 *
 * "pending" means it could still show, so the reader holds its space: the
 * messages below never move down when it lands, and fold up if it doesn't.
 */
export function getCueStripVisibility({
  categories,
  categoriesLoaded,
  fromPerson,
  insight,
}: {
  categories: Set<string>;
  /** False while the thread's rule runs are still loading. */
  categoriesLoaded: boolean;
  /** Whether someone else wrote the newest message, as a person (`isFromPerson`). */
  fromPerson: boolean;
  /** Undefined while loading; null when Cue has no note for the email. */
  insight: Pick<EmailInsight, "action"> | null | undefined;
}): CueStripVisibility {
  if (CONVERSATION_TYPES.some((type) => categories.has(type))) return "show";
  if (AUTOMATED_TYPES.some((type) => categories.has(type))) return "hide";
  if (!fromPerson) return "hide";
  if (!categoriesLoaded || insight === undefined) return "pending";
  return insight?.action === "reply" || insight?.action === "do"
    ? "show"
    : "hide";
}

/**
 * A person's own address, not a no-reply or notification sender, and not mail
 * sent to a list. Decided from the message alone, so the reader knows at once.
 */
export function isFromPerson(headers: {
  from: string;
  "list-unsubscribe"?: string;
}) {
  return (
    !headers["list-unsubscribe"] &&
    !isAutomatedAddress(extractEmailAddress(headers.from))
  );
}
