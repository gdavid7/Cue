import { parseISO } from "date-fns/parseISO";

/** The longest invitation the conflict check reads a calendar for. */
export const MAX_CONFLICT_WINDOW_MS = 24 * 60 * 60 * 1000;

type TimeRange = { start: Date; end: Date };

// Back-to-back meetings share an edge without overlapping.
export function rangesOverlap(a: TimeRange, b: TimeRange) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Whether every moment of `range` falls inside one of `covers`, so busy time
 * there is accounted for by events we know about.
 */
export function isCovered(range: TimeRange, covers: TimeRange[]) {
  let coveredUntil = range.start;
  for (const cover of [...covers].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  )) {
    if (cover.start > coveredUntil) break;
    if (cover.end > coveredUntil) coveredUntil = cover.end;
    if (coveredUntil >= range.end) return true;
  }
  return coveredUntil >= range.end;
}

/**
 * The instants an invitation occupies, or null when there is nothing worth
 * checking: all-day invitations (they block a date, not a time), ones with no
 * end, ones already over, and ones longer than the check reads.
 */
export function getInvitationWindow(
  invitation: { start: string; end: string | null; allDay: boolean },
  now: Date,
): TimeRange | null {
  if (invitation.allDay || !invitation.end) return null;
  const start = toInstant(invitation.start);
  const end = toInstant(invitation.end);
  const length = end.getTime() - start.getTime();
  if (Number.isNaN(length) || length <= 0 || length > MAX_CONFLICT_WINDOW_MS)
    return null;
  if (end <= now) return null;
  return { start, end };
}

/**
 * A calendar event that is the invitation itself, already on the calendar
 * under a UID the provider rewrote (Exchange does this for outside invites).
 */
export function isInvitationCopy(
  event: { title: string | null; start: string; end: string },
  invitation: { title: string } & TimeRange,
) {
  return (
    event.title?.trim() === invitation.title.trim() &&
    new Date(event.start).getTime() === invitation.start.getTime() &&
    new Date(event.end).getTime() === invitation.end.getTime()
  );
}

// The parser keeps a floating time (no zone) as a wall clock, which the card
// shows as-is, so it is read in the viewer's own zone here too.
function toInstant(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? new Date(value)
    : parseISO(value);
}
