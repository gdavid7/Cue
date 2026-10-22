"use client";

import { type ReactNode, useState } from "react";
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clock3Icon,
} from "lucide-react";
import {
  formatSnoozeTime,
  getSnoozePresets,
} from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
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

/**
 * The reader's snooze control: the same presets as `h` in the command palette,
 * plus a date and time of your own.
 */
export function SnoozeButton({
  onSnooze,
  trigger,
}: {
  onSnooze: (until: Date) => void;
  /** Replaces the toolbar icon button; must be a single focusable element. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState("");
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
  const choose = (until: Date) => {
    onOpenChange(false);
    onSnooze(until);
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <Tooltip shortcuts={["snooze"]}>
          <PopoverTrigger asChild>
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
            {getSnoozePresets(new Date()).map((preset) => (
              <Button
                className="flex h-9 w-full justify-between gap-3 px-2 font-normal text-xs"
                key={preset.id}
                onClick={() => choose(preset.until)}
                type="button"
                variant="ghost"
              >
                <span>{preset.label}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatSnoozeTime(preset.until)}
                </span>
              </Button>
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
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
