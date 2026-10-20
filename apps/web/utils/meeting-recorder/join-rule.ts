import { MeetingJoinRule } from "@/generated/prisma/enums";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { canonicalizeEmailAddress } from "@/utils/email";
import { partitionAttendeesForBriefing } from "@/utils/meeting-briefs/attendees";

/**
 * Single source of truth for whether the notetaker joins a meeting. Both the
 * reconciler and the upcoming-meetings API call this, so the toggle a user sees
 * always matches what the cron will actually do.
 */
export function shouldAutoJoin({
  event,
  rule,
  userEmail,
  ownAddresses,
  joinOverride,
}: {
  event: CalendarEvent;
  rule: MeetingJoinRule;
  userEmail: string;
  /** The user's other connected mailboxes, who are never external guests. */
  ownAddresses: string[];
  joinOverride?: boolean | null;
}): boolean {
  // A per-meeting override always wins, including turning a meeting on when the
  // rule is OFF.
  if (joinOverride != null) return joinOverride;

  if (!event.videoConferenceLink) return false;

  switch (rule) {
    case MeetingJoinRule.ALL:
      return true;
    case MeetingJoinRule.EXTERNAL_ONLY:
      return (
        partitionAttendeesForBriefing(event, userEmail, ownAddresses).external
          .length > 0
      );
    case MeetingJoinRule.HOST_ONLY:
      return isHost({ event, userEmail, ownAddresses });
    case MeetingJoinRule.OFF:
      return false;
  }
}

// `isOrganizer` is relative to the connected calendar, which may be a different
// address than the email account, so fall back to comparing the organizer
// email with the account's and the user's other mailboxes.
function isHost({
  event,
  userEmail,
  ownAddresses,
}: {
  event: CalendarEvent;
  userEmail: string;
  ownAddresses: string[];
}): boolean {
  if (event.isOrganizer === true) return true;

  const organizerEmail = canonicalizeEmailAddress(event.organizerEmail ?? "");
  if (!organizerEmail) return false;
  return [userEmail, ...ownAddresses].some(
    (address) => canonicalizeEmailAddress(address) === organizerEmail,
  );
}
