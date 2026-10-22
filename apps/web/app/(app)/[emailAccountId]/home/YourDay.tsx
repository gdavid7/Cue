"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import { MailIcon } from "lucide-react";
import type { PersonCardConversation } from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import type { GetCalendarTodayEventsResponse } from "@/app/api/user/calendar/upcoming-events/route";
import {
  getReplyTrackingLabels,
  PersonCardScope,
  PersonCardTrigger,
  personCardRequest,
} from "@/components/person-card/PersonCard";
import { Badge } from "@/components/ui/badge";
import { useLabels } from "@/hooks/useLabels";
import { useOwnEmailAddresses } from "@/hooks/useOwnEmailAddresses";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { formatShortDate } from "@/utils/date";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import { formatTime } from "./today-format";

type DayEvent = GetCalendarTodayEventsResponse["events"][number];
type Attendee = DayEvent["attendees"][number];
type Scope = ComponentProps<typeof PersonCardScope>["value"];
type ThreadHref = (thread: {
  threadId: string;
  account?: { id: string };
}) => string;

const CHIPS_SHOWN = 3;
// Each person is one indexed read of this device's mail, as opening their
// card is; a day's meetings stay well within that.
const PEOPLE_READ = 24;

/**
 * Today's meetings, each with the people on it and the last conversation
 * you had with them. People open their card; the conversation opens in the
 * reader. Everything about the mail is read from this device's store, so
 * nothing here asks the server or a model.
 */
export function YourDay({
  events,
  more,
  now,
  layout,
  accountIds,
  threadHref,
}: {
  events: DayEvent[];
  /** Meetings today that the strip left out. */
  more: number;
  now: Date;
  layout: MailLayoutMode;
  /** Across accounts: every account Today shows, whose mail is read. */
  accountIds?: string[];
  threadHref: ThreadHref;
}) {
  const { emailAccountId } = useAccount();
  const ownAddresses = useOwnEmailAddresses();
  const { userLabels } = useLabels();
  const router = useRouter();
  const scope = useMemo<Scope>(
    () => ({
      accountIds: accountIds ?? [emailAccountId],
      ownAddresses,
      // Today has the open account's labels only, so the card's "waiting
      // on" lists cover that account.
      replyTracking: [
        getReplyTrackingLabels(
          emailAccountId,
          Object.fromEntries(userLabels.map((label) => [label.id, label])),
        ),
      ],
      openConversation: null,
      onOpenConversation: (accountId, conversationId) =>
        router.push(
          threadHref({
            threadId: conversationId,
            account: accountIds ? { id: accountId } : undefined,
          }),
        ),
    }),
    [accountIds, emailAccountId, ownAddresses, userLabels, router, threadHref],
  );
  const threadsByPerson = useConversationsWith(events, scope);

  if (!events.length) return null;

  return (
    <PersonCardScope value={scope}>
      <ul className="-mx-4 sm:mx-0 border-border/60 border-t motion-safe:animate-in motion-safe:fade-in">
        {events.map((event) => (
          <MeetingRow
            event={event}
            key={event.id}
            layout={layout}
            now={now}
            thread={latestSharedConversation(event.attendees, threadsByPerson)}
            threadHref={(thread) =>
              threadHref({
                threadId: thread.conversationId,
                account: accountIds ? { id: thread.accountId } : undefined,
              })
            }
          />
        ))}
      </ul>
      {more > 0 ? (
        <p className="mt-2 pl-4 text-muted-foreground text-xs sm:pl-8">
          {more} more today
        </p>
      ) : null}
    </PersonCardScope>
  );
}

function MeetingRow({
  event,
  layout,
  now,
  thread,
  threadHref,
}: {
  event: DayEvent;
  layout: MailLayoutMode;
  now: Date;
  thread: PersonCardConversation | null;
  threadHref: (thread: PersonCardConversation) => string;
}) {
  const ended = new Date(event.endTime) <= now;
  const ongoing = !ended && new Date(event.startTime) <= now;
  const chips = event.attendees.slice(0, CHIPS_SHOWN);
  const hidden = event.attendees.length - chips.length;

  return (
    // The inbox row's insets, so meetings line up with the lanes around them.
    <li
      className={cn(
        "flex gap-2.5 border-border/60 border-b bg-background py-2.5 pl-8",
        layout === "list" ? "pr-5" : "pr-3.5",
      )}
    >
      <span
        className={cn(
          "shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums",
          layout === "list" ? "w-24" : "w-16",
          ongoing ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {ongoing ? "Now" : formatTime(event.startTime)}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              ended ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {event.eventUrl ? (
              <a
                className="underline-offset-2 hover:underline"
                href={event.eventUrl}
                rel="noreferrer"
                target="_blank"
              >
                {event.title}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              event.title
            )}
          </p>
          {event.calendarEmail ? (
            <span className="max-w-[40%] shrink-0 truncate text-muted-foreground text-xs">
              {event.calendarEmail}
            </span>
          ) : null}
        </div>
        {chips.length ? (
          <div className="flex flex-wrap items-center gap-1">
            {chips.map((attendee) => (
              <PersonCardTrigger
                className="max-w-full rounded-md"
                email={attendee.email}
                key={attendee.email}
                name={attendee.name ?? ""}
              >
                <Badge
                  className="max-w-40 transition-colors hover:bg-muted/70 active:bg-border max-sm:min-h-7"
                  size="sm"
                  variant="muted"
                >
                  <span className="truncate">{chipLabel(attendee)}</span>
                </Badge>
              </PersonCardTrigger>
            ))}
            {hidden > 0 ? (
              <span className="text-muted-foreground text-xs">+{hidden}</span>
            ) : null}
          </div>
        ) : null}
        {thread ? (
          <Link
            className="flex min-w-0 items-center gap-1.5 rounded text-muted-foreground text-xs transition-colors max-sm:min-h-7 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={threadHref(thread)}
          >
            <MailIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only">Last email: </span>
            <span className="truncate">
              {thread.subject.trim() || "(no subject)"}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              · {formatShortDate(new Date(thread.latestMessageAtMs))}
            </span>
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Each meeting person's recent conversations, keyed by lowercased address,
 * read through the person card's own query. Each card read is also kept
 * where the card looks, so a chip opens its card at once.
 */
function useConversationsWith(events: DayEvent[], scope: Scope) {
  const client = useOptionalMailClient() ?? getActiveMailClient();
  const readCard = client?.queryPersonCard?.bind(client);
  const { mutate } = useSWRConfig();
  const people = useMemo(() => {
    const byAddress = new Map<string, string>();
    for (const event of events)
      for (const { email } of event.attendees)
        if (!byAddress.has(email.toLowerCase()))
          byAddress.set(email.toLowerCase(), email);
    return [...byAddress.values()].slice(0, PEOPLE_READ);
  }, [events]);
  const { accountIds, ownAddresses, replyTracking } = scope;

  const { data } = useSWR(
    readCard && people.length
      ? [
          "your-day-conversations",
          JSON.stringify({ people, accountIds, ownAddresses, replyTracking }),
        ]
      : null,
    async () => {
      const conversations = new Map<string, PersonCardConversation[]>();
      // One at a time: the store answers the reader too.
      for (const email of people) {
        const { query, key } = personCardRequest(
          { accountIds, ownAddresses, replyTracking },
          email,
        );
        const card = await readCard?.(query).catch(() => null);
        if (!card) continue;
        mutate(key, card, { revalidate: false });
        conversations.set(email.toLowerCase(), card.conversations);
      }
      return conversations;
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  return data;
}

/**
 * The conversation with the most of the meeting's people, newest first among
 * equals: the one about this meeting more often than a newer side thread.
 */
function latestSharedConversation(
  attendees: Attendee[],
  conversationsByPerson: Map<string, PersonCardConversation[]> | undefined,
): PersonCardConversation | null {
  if (!conversationsByPerson) return null;
  const tally = new Map<
    string,
    { conversation: PersonCardConversation; people: number }
  >();
  for (const attendee of attendees) {
    const seen = new Set<string>();
    for (const conversation of conversationsByPerson.get(
      attendee.email.toLowerCase(),
    ) ?? []) {
      const key = `${conversation.accountId}:${conversation.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = tally.get(key);
      if (entry) entry.people++;
      else tally.set(key, { conversation, people: 1 });
    }
  }
  let best: { conversation: PersonCardConversation; people: number } | null =
    null;
  for (const entry of tally.values()) {
    if (
      !best ||
      entry.people > best.people ||
      (entry.people === best.people &&
        entry.conversation.latestMessageAtMs >
          best.conversation.latestMessageAtMs)
    )
      best = entry;
  }
  return best?.conversation ?? null;
}

function chipLabel(attendee: Attendee) {
  return attendee.name?.trim() || attendee.email.split("@")[0];
}
