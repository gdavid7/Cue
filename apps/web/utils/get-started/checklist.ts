import { getInboxStyleHintId } from "@/utils/split-inbox/inbox-styles";

/** The week-1 checklist, in the order it teaches Cue's core loop. */
export const GET_STARTED_ITEM_IDS = [
  "inbox-style",
  "keyboard",
  "reply",
  "ask",
  "calendar",
  "phone",
] as const;
export type GetStartedItemId = (typeof GET_STARTED_ITEM_IDS)[number];

/** Steps only the browser sees, saved as hints when they happen. */
export type GetStartedClientStep = Extract<
  GetStartedItemId,
  "keyboard" | "ask" | "phone"
>;

export const GET_STARTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const GET_STARTED_DISMISSED_HINT = "get-started:dismissed";
/** Triage done from the keyboard before the step counts. */
export const KEYBOARD_TRIAGE_GOAL = 5;

/** Saved by compose when the first reply started from Cue's suggestion is sent. */
export function getFirstReplySentHintId(emailAccountId: string) {
  return `first-reply-sent:${emailAccountId}`;
}

export function getGetStartedStepHintId(step: GetStartedClientStep) {
  return `get-started:${step}`;
}

/** What the database knows about each account, for the steps it records. */
export type GetStartedFacts = {
  calendarAccountIds: ReadonlySet<string>;
  chatAccountIds: ReadonlySet<string>;
  sentSuggestionAccountIds: ReadonlySet<string>;
};

type GetStartedUser = {
  createdAt: Date | string;
  dismissedHints: readonly string[];
};

/**
 * Whether the checklist may still show: in the first week, and not closed.
 * The browser asks this before saving a step, so older accounts save nothing.
 */
export function isGetStartedWindowOpen(user: GetStartedUser, now: Date) {
  if (user.dismissedHints.includes(GET_STARTED_DISMISSED_HINT)) return false;
  return (
    now.getTime() - new Date(user.createdAt).getTime() < GET_STARTED_WINDOW_MS
  );
}

/** Each step is done once any of the person's accounts has done it. */
export function getGetStartedItems({
  dismissedHints,
  emailAccountIds,
  facts,
}: {
  dismissedHints: readonly string[];
  emailAccountIds: readonly string[];
  facts: GetStartedFacts;
}): { id: GetStartedItemId; done: boolean }[] {
  const hints = new Set(dismissedHints);
  const anyAccount = (test: (emailAccountId: string) => boolean) =>
    emailAccountIds.some(test);
  const done: Record<GetStartedItemId, boolean> = {
    "inbox-style": anyAccount((id) => hints.has(getInboxStyleHintId(id))),
    keyboard: hints.has(getGetStartedStepHintId("keyboard")),
    reply: anyAccount(
      (id) =>
        hints.has(getFirstReplySentHintId(id)) ||
        facts.sentSuggestionAccountIds.has(id),
    ),
    ask:
      hints.has(getGetStartedStepHintId("ask")) ||
      anyAccount((id) => facts.chatAccountIds.has(id)),
    calendar: anyAccount((id) => facts.calendarAccountIds.has(id)),
    phone: hints.has(getGetStartedStepHintId("phone")),
  };
  return GET_STARTED_ITEM_IDS.map((id) => ({ id, done: done[id] }));
}

/**
 * Where a person stands: showing, or hidden because they closed it, the first
 * week is over, or every step is done.
 */
export function getGetStartedStatus({
  user,
  items,
  now,
}: {
  user: GetStartedUser;
  items: { done: boolean }[];
  now: Date;
}): "active" | "done" | "dismissed" | "expired" {
  if (items.every((item) => item.done)) return "done";
  if (user.dismissedHints.includes(GET_STARTED_DISMISSED_HINT))
    return "dismissed";
  return isGetStartedWindowOpen(user, now) ? "active" : "expired";
}
