"use client";

import { getAccountScopedKey } from "@/utils/swr";
import useSWR from "swr";
import { useAction } from "next-safe-action/hooks";
import { CalendarIcon, MapPinIcon, VideoIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import { respondToCalendarInvitationAction } from "@/utils/actions/calendar-invitation";
import { getActionErrorMessage } from "@/utils/error";
import type { CalendarInvitationResponse } from "@/app/api/messages/calendar-invitation/route";
import type { GetCalendarConflictsResponse } from "@/app/api/user/calendar/conflicts/route";
import {
  getInvitationWindow,
  isInvitationCopy,
} from "@/utils/calendar/conflicts";
import { formatInvitationTime } from "@/utils/calendar/invitations/format-time";
import type { InvitationResponse } from "@/utils/calendar/invitations/parser";

// The card reads the meeting time in the zone the viewer's device is set to.
const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function CalendarInvitation({ messageId }: { messageId: string }) {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useSWR<CalendarInvitationResponse>(
    getAccountScopedKey(
      `/api/messages/calendar-invitation?messageId=${encodeURIComponent(messageId)}`,
      emailAccountId,
    ),
  );
  const [submitted, setSubmitted] = useState<{
    response: InvitationResponse;
    calendarSynced: boolean;
  } | null>(null);
  const { execute, isExecuting } = useAction(
    respondToCalendarInvitationAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        setSubmitted(data);
        mutate();
      },
      onError: ({ error }) =>
        toastError({ description: getActionErrorMessage(error) }),
    },
  );
  if (!isLoading && !error && !data?.invitation) return null;
  const invitation = data?.invitation;
  const response = submitted?.response ?? invitation?.response;
  let status =
    "No matching calendar event was verified. Your response will be emailed to the organizer.";
  if (invitation?.calendarSynced)
    status =
      "Your response will update your calendar and notify the organizer.";
  if (submitted) {
    status = submitted.calendarSynced
      ? "Response sent and calendar updated."
      : "Response emailed to the organizer. Calendar sync wasn’t confirmed.";
  }
  if (isExecuting) status = "Sending response…";
  return (
    <section
      className="mb-4 rounded-lg border bg-muted/30 p-4"
      aria-label="Calendar invitation"
    >
      <LoadingContent loading={isLoading} error={error}>
        {invitation && (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <CalendarIcon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium break-words">
                  {formatInvitationTime(invitation, viewerTimeZone)}
                </p>
                <p className="break-words">{invitation.title}</p>
                <p className="break-all text-sm text-muted-foreground">
                  {invitation.organizer}
                </p>
                <ConflictHint invitation={invitation} />
                {invitation.recurring && (
                  <p className="text-sm text-muted-foreground">
                    Recurring invitation
                  </p>
                )}
              </div>
            </div>

            {invitation.location && (
              <DetailRow icon={MapPinIcon}>
                <span className="break-words">{invitation.location}</span>
              </DetailRow>
            )}

            {invitation.conferenceUrl && (
              <DetailRow icon={VideoIcon}>
                <a
                  href={invitation.conferenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all underline underline-offset-2"
                >
                  {invitation.conferenceUrl.replace(/^https?:\/\//, "")}
                </a>
              </DetailRow>
            )}

            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Your response</legend>
              {(
                [
                  ["accepted", "Yes"],
                  ["declined", "No"],
                  ["tentative", "Maybe"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={response === value ? "default" : "outline"}
                  aria-pressed={response === value}
                  disabled={isExecuting}
                  onClick={() => execute({ messageId, response: value })}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <p className="text-sm text-muted-foreground" role="status">
              {status}
            </p>
          </div>
        )}
      </LoadingContent>
    </section>
  );
}

type Invitation = NonNullable<CalendarInvitationResponse["invitation"]>;

// Read live from the person's calendars when the card opens, at most once a
// minute; the line stays away when there is nothing certain to say.
function ConflictHint({ invitation }: { invitation: Invitation }) {
  const { emailAccountId } = useAccount();
  const slot = getInvitationWindow(invitation, new Date());
  const params = slot
    ? new URLSearchParams({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })
    : null;
  if (params && invitation.uid) params.set("uid", invitation.uid);
  const { data } = useSWR<GetCalendarConflictsResponse>(
    params
      ? getAccountScopedKey(
          `/api/user/calendar/conflicts?${params}`,
          emailAccountId,
        )
      : null,
    // Each read asks every connected calendar, so a glance away and back
    // doesn't ask again.
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
  if (!slot || data?.status !== "ok") return null;

  const [first, ...rest] = data.conflicts.filter(
    (event) => !isInvitationCopy(event, { ...invitation, ...slot }),
  );
  return (
    <p className="flex min-w-0 gap-1 text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
      {first ? (
        <>
          <span className="truncate">
            {first.title
              ? `Conflicts with ${first.title}`
              : "Conflicts with a meeting"}
          </span>
          {rest.length > 0 && (
            <span className="shrink-0">and {rest.length} more</span>
          )}
        </>
      ) : (
        "You’re free then"
      )}
    </p>
  );
}

function DetailRow({
  icon: Icon,
  children,
}: {
  icon: typeof CalendarIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
