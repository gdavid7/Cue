import type { GetHomeResponse } from "@/app/api/user/home/route";

type NextUpItem = GetHomeResponse["nextUp"][number];

// Times show in the browser's time zone, the one Today's data was asked for.

/** "2:00 PM". */
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 45 minutes", "in 3 hours". */
export function formatFromNow(iso: string, now: Date) {
  const minutes = Math.max(
    0,
    Math.round((new Date(iso).getTime() - now.getTime()) / 60_000),
  );
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return minutes < 60
    ? format.format(minutes, "minute")
    : format.format(Math.round(minutes / 60), "hour");
}

/** "today", "tomorrow", a weekday within the week, or a date after that. */
export function formatDay(iso: string, now: Date) {
  const days = daysFrom(now, iso);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const date = new Date(iso);
  if (days > 1 && days < 7)
    return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * When a Next up item happens, short enough for a narrow column: "2:00 PM"
 * today, "Wed 9:00 AM" later; a deadline reads "Due today" or "Due Wed".
 */
export function formatWhen(item: NextUpItem, now: Date) {
  const today = daysFrom(now, item.at) === 0;
  const date = new Date(item.at);
  const day =
    daysFrom(now, item.at) < 7
      ? date.toLocaleDateString(undefined, { weekday: "short" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (item.kind === "event")
    return today ? formatTime(item.at) : `${day} ${formatTime(item.at)}`;
  if (today) return item.allDay ? "Due today" : `Due ${formatTime(item.at)}`;
  return `Due ${day}`;
}

/**
 * Who a bundle of mail is from, newest first, each once: "Field Notes,
 * Morning Brew and Stratechery", or "Field Notes, Morning Brew, Stratechery
 * and 2 more" past `shown` senders.
 */
export function formatSenders(names: string[], shown = 3) {
  const senders = [
    ...new Set(names.map((name) => name.trim()).filter(Boolean)),
  ];
  if (senders.length <= shown) {
    if (senders.length < 2) return senders[0] ?? "";
    return `${senders.slice(0, -1).join(", ")} and ${senders.at(-1)}`;
  }
  return `${senders.slice(0, shown).join(", ")} and ${senders.length - shown} more`;
}

function daysFrom(now: Date, iso: string) {
  return Math.round(
    (startOfLocalDay(new Date(iso)).getTime() -
      startOfLocalDay(now).getTime()) /
      86_400_000,
  );
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
