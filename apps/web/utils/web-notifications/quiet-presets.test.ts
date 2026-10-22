import { describe, expect, it } from "vitest";
import { parseSnoozeDate } from "@/app/(app)/[emailAccountId]/mail/snooze-date-parse";
import {
  buildQuietPageCommands,
  buildQuietRootCommand,
} from "@/utils/web-notifications/quiet-command-palette";
import {
  formatQuietUntil,
  getQuietPresets,
} from "@/utils/web-notifications/quiet-presets";

// Local times, so these hold in any time zone the suite runs in.
const WEDNESDAY_AFTERNOON = new Date(2026, 9, 21, 14, 30);
const SUNDAY_EVENING = new Date(2026, 9, 25, 21, 0);
const THURSDAY_EARLY = new Date(2026, 9, 22, 2, 0);

function presetTimes(now: Date) {
  return Object.fromEntries(
    getQuietPresets(now).map((preset) => [preset.label, preset.until]),
  );
}

describe("getQuietPresets", () => {
  it("offers an hour, tomorrow at 8:00 and Monday at 8:00 in local time", () => {
    expect(presetTimes(WEDNESDAY_AFTERNOON)).toEqual({
      "For 1 hour": new Date(2026, 9, 21, 15, 30),
      "Until tomorrow morning": new Date(2026, 9, 22, 8, 0),
      "Until Monday morning": new Date(2026, 9, 26, 8, 0),
    });
  });

  it("ends a pause chosen after midnight the same morning", () => {
    expect(presetTimes(THURSDAY_EARLY)["Until this morning"]).toEqual(
      new Date(2026, 9, 22, 8, 0),
    );
  });

  it("does not offer Monday twice on a Sunday", () => {
    expect(Object.keys(presetTimes(SUNDAY_EVENING))).toEqual([
      "For 1 hour",
      "Until tomorrow morning",
    ]);
  });
});

describe("formatQuietUntil", () => {
  it("names the day only when it isn't today", () => {
    const now = WEDNESDAY_AFTERNOON;
    expect(formatQuietUntil(new Date(2026, 9, 21, 21, 0), now)).toBe("9:00 PM");
    expect(formatQuietUntil(new Date(2026, 9, 22, 8, 0), now)).toBe(
      "tomorrow at 8:00 AM",
    );
    expect(formatQuietUntil(new Date(2026, 9, 26, 8, 0), now)).toBe(
      "Mon, Oct 26 at 8:00 AM",
    );
  });
});

describe("pausing from the command palette", () => {
  it("pauses until a typed time, with mornings at 8:00 like the presets", () => {
    const paused: Date[] = [];
    const [command] = buildQuietPageCommands({
      now: WEDNESDAY_AFTERNOON,
      pause: (until) => paused.push(until),
      parseDate: parseSnoozeDate,
      query: "friday",
    });

    expect(command.label).toBe("Pause until Fri, Oct 23 at 8:00 AM");
    command.action();
    expect(paused).toEqual([new Date(2026, 9, 23, 8, 0)]);
  });

  it("offers nothing for a time it can't read, one in the past, or one past 30 days", () => {
    for (const query of ["whenever", "yesterday at noon", "in 2 months"])
      expect(
        buildQuietPageCommands({
          now: WEDNESDAY_AFTERNOON,
          pause: () => undefined,
          parseDate: parseSnoozeDate,
          query,
        }),
      ).toEqual([]);
  });

  it("turns into Resume while paused", () => {
    const command = buildQuietRootCommand({
      now: WEDNESDAY_AFTERNOON,
      quietUntilMs: new Date(2026, 9, 22, 8, 0).getTime(),
      openPausePage: () => undefined,
      resume: () => undefined,
    });

    expect(command.label).toBe("Resume notifications");
    expect(command.description).toBe("Paused until tomorrow at 8:00 AM");
  });
});
