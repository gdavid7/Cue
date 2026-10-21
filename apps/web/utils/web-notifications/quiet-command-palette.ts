import { MoonIcon } from "lucide-react";
import type { SnoozeDateParser } from "@/app/(app)/[emailAccountId]/mail/snooze-date-parse";
import type { Command } from "@/lib/commands/types";
import { MAX_QUIET_MS } from "@/utils/web-notifications/preference";
import {
  formatQuietUntil,
  getQuietPresets,
  QUIET_MORNING_HOUR,
} from "@/utils/web-notifications/quiet-presets";

const KEYWORDS = [
  "pause",
  "quiet",
  "mute",
  "silence",
  "focus",
  "do not disturb",
  "notifications",
  "alerts",
];

/** The one entry on the palette's first page: pause, or resume while paused. */
export function buildQuietRootCommand({
  now = new Date(),
  quietUntilMs,
  openPausePage,
  resume,
}: {
  now?: Date;
  quietUntilMs: number | null;
  openPausePage: () => void;
  resume: () => void;
}): Command {
  if (quietUntilMs !== null)
    return {
      id: "notifications-resume",
      label: "Resume notifications",
      description: `Paused until ${formatQuietUntil(new Date(quietUntilMs), now)}`,
      icon: MoonIcon,
      section: "settings",
      keywords: [...KEYWORDS, "resume", "unpause", "unmute"],
      action: resume,
    };
  return {
    id: "notifications-pause",
    label: "Pause notifications…",
    icon: MoonIcon,
    section: "settings",
    keywords: KEYWORDS,
    closeOnSelect: false,
    action: openPausePage,
  };
}

export function buildQuietPageCommands({
  now = new Date(),
  pause,
  parseDate,
  query,
}: {
  now?: Date;
  pause: (until: Date) => void;
  /** Null while the parser loads; typed times show once it has. */
  parseDate: SnoozeDateParser | null;
  query: string;
}): Command[] {
  if (query.trim()) {
    const until = parseDate?.(query, now, { defaultHour: QUIET_MORNING_HOUR });
    // Past the limit there is no match, rather than a pause shorter than asked.
    if (!until || until.getTime() > now.getTime() + MAX_QUIET_MS) return [];
    return [
      {
        id: "notifications-pause-typed",
        label: `Pause until ${formatQuietUntil(until, now)}`,
        section: "actions",
        keywords: [query],
        action: () => pause(until),
      },
    ];
  }

  return getQuietPresets(now).map((preset, index) => ({
    id: `notifications-pause-${preset.id}`,
    label: preset.label,
    description: formatQuietUntil(preset.until, now),
    section: "actions",
    priority: index,
    keywords: KEYWORDS,
    action: () => pause(preset.until),
  }));
}
