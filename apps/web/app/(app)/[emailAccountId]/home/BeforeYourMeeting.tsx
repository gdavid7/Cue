"use client";

import { NewspaperIcon } from "lucide-react";
import { useMeetingNews } from "@/hooks/useMeetingNews";

/**
 * Recent public news about the outside organization in each meeting of the
 * next two days. Shows nothing until there's news to show: no placeholder,
 * no error, since it's extra rather than something the user is waiting on.
 */
export function BeforeYourMeeting({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const { data } = useMeetingNews(emailAccountId);
  if (!data?.meetings.length) return null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.meetings.map((meeting) => (
        <section
          className="rounded-xl border border-border bg-card p-4"
          key={meeting.eventId}
        >
          <h2 className="flex items-center gap-2 font-medium text-sm">
            <NewspaperIcon className="size-4 text-primary" />
            Before your meeting
          </h2>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {meeting.title} · {formatMeetingTime(meeting.startTime)} · News
            about {meeting.organization}
          </p>
          <ul className="mt-2 space-y-1">
            {meeting.news.map((item) => (
              <li key={item.url}>
                <a
                  className="-mx-2 block rounded-md px-2 py-1.5 hover:bg-muted/60"
                  href={item.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <div className="line-clamp-1 text-foreground text-sm">
                    {item.title}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {item.domain}
                    {item.publishedDate
                      ? ` · ${formatNewsDate(item.publishedDate)}`
                      : ""}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function formatMeetingTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatNewsDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
