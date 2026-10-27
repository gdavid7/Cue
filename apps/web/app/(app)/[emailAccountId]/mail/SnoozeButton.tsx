"use client";

import { type ReactNode, useState } from "react";
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clock3Icon,
} from "lucide-react";
import useSWR from "swr";
import {
  formatSnoozeTime,
  getSnoozePresets,
} from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
import type { GetSnoozeTimesResponse } from "@/app/api/user/calendar/snooze-times/route";
import { Tooltip } from "@/components/Tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ALL_SHORTCUTS_OFF,
  MAIL_SHORTCUTS_OFF_ATTRIBUTE,
} from "@/lib/shortcuts/registry";
import { getAccountScopedKey } from "@/utils/swr";

/**
 * The reader's snooze control: the clock presets of `h` in the command palette
 * and a date and time of your own. With a calendar connected it also offers
 * times read from the calendar of the conversation's own account, listed last
 * so the rows under the pointer never move when they arrive.
 */
export function SnoozeButton({
  emailAccountId,
  onSnooze,
  trigger,
}: {
  /** The account the conversation belongs to, whose calendar is read. */
  emailAccountId: string;
  onSnooze: (until: Date) => void;
  /** Replaces the toolbar icon button; must be a single focusable element. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState("");
  const [warm, setWarm] = useState(false);
  // Read once the picker opens, or when the pointer or focus reaches the
  // trigger so it's usually ready by then. Until it answers, or if it can't,
  // the calendar presets simply aren't there. Each read asks every connected
  // calendar, so a quick reopen doesn't ask again.
  const { data: calendarTimes, error: calendarError } =
    useSWR<GetSnoozeTimesResponse>(
      open || warm
        ? getAccountScopedKey("/api/user/calendar/snooze-times", emailAccountId)
        : null,
      {
        revalidateOnFocus: false,
        revalidateIfStale: false,
        dedupingInterval: 60_000,
        shouldRetryOnError: false,
      },
    );
  const now = new Date();
  const calendarPresets = calendarError
    ? []
    : [
        {
          id: "after-next-meeting",
          label: "After my next meeting",
          until: calendarTimes?.afterNextMeeting,
        },
        {
          id: "next-free-hour",
          label: "Next free hour",
          until: calendarTimes?.nextFreeHour,
        },
      ].flatMap(({ until, ...preset }) => {
        if (!until) return [];
        const date = new Date(until);
        // A time kept from an earlier open may have passed since.
        return date > now ? [{ ...preset, until: date }] : [];
      });
  const customDate = custom ? new Date(custom) : null;
  const canSnoozeUntilCustom =
    customDate !== null &&
    !Number.isNaN(customDate.getTime()) &&
    customDate.getTime() > Date.now();

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setShowCustom(false);
      setCustom("");
    }
  };
  const triggerProps = {
    onFocus: () => setWarm(true),
    onPointerEnter: () => setWarm(true),
  };
  const choose = (until: Date) => {
    onOpenChange(false);
    onSnooze(until);
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      {trigger ? (
        <PopoverTrigger asChild {...triggerProps}>
          {trigger}
        </PopoverTrigger>
      ) : (
        <Tooltip shortcuts={["snooze"]}>
          <PopoverTrigger asChild {...triggerProps}>
            <Button aria-label="Snooze" size="iconXs" variant="outline">
              <Clock3Icon className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </Tooltip>
      )}
      <PopoverContent
        align="end"
        aria-label="Snooze until"
        className="w-72 p-1"
        // Portaled out of whatever opened it, so without this `e` pressed on
        // a preset would archive the conversation behind it, and `c` would
        // start a message over Catch up's overlay.
        {...{ [MAIL_SHORTCUTS_OFF_ATTRIBUTE]: ALL_SHORTCUTS_OFF }}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        {showCustom ? (
          <div className="space-y-3 p-2">
            <Button
              className="-ml-1 h-7 gap-1 px-1 text-xs"
              onClick={() => setShowCustom(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeftIcon className="size-3.5" />
              Back
            </Button>
            <label className="block text-muted-foreground text-xs">
              Choose a date and time
              <input
                aria-label="Snooze date and time"
                className="mt-2 w-full rounded-md border border-input bg-background p-2 text-foreground text-sm"
                onChange={(event) => setCustom(event.target.value)}
                type="datetime-local"
                value={custom}
              />
            </label>
            <Button
              className="w-full"
              disabled={!canSnoozeUntilCustom}
              onClick={() => customDate && choose(customDate)}
              size="sm"
              type="button"
            >
              Snooze
            </Button>
          </div>
        ) : (
          <>
            {getSnoozePresets(now).map((preset) => (
              <SnoozePresetButton
                key={preset.id}
                label={preset.label}
                onClick={() => choose(preset.until)}
                until={preset.until}
              />
            ))}
            <div className="my-1 border-t" />
            <Button
              className="h-9 w-full justify-start gap-2 px-2 font-normal text-xs"
              onClick={() => setShowCustom(true)}
              type="button"
              variant="ghost"
            >
              <CalendarDaysIcon className="size-3.5 text-muted-foreground" />
              Choose date and time
              <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
            </Button>
            {calendarPresets.length ? (
              <>
                <div className="my-1 border-t" />
                {calendarPresets.map((preset) => (
                  <SnoozePresetButton
                    key={preset.id}
                    label={preset.label}
                    onClick={() => choose(preset.until)}
                    until={preset.until}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SnoozePresetButton({
  label,
  until,
  onClick,
}: {
  label: string;
  until: Date;
  onClick: () => void;
}) {
  return (
    <Button
      className="flex h-9 w-full justify-between gap-3 px-2 font-normal text-xs"
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      <span>{label}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatSnoozeTime(until)}
      </span>
    </Button>
  );
}
