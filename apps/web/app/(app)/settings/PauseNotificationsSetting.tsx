"use client";

import { useState } from "react";
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";
import {
  pauseWebNotifications,
  resumeWebNotifications,
} from "@/utils/web-notifications/permission";
import { MAX_QUIET_MS } from "@/utils/web-notifications/preference";
import { isWebPushAvailable } from "@/utils/web-push/subscription";
import {
  formatQuietUntil,
  getQuietPresets,
} from "@/utils/web-notifications/quiet-presets";

/** A pause for this browser only; the chosen mode stays as it is. */
export function PauseNotificationsSetting({
  quietUntilMs,
}: {
  quietUntilMs: number | null;
}) {
  if (quietUntilMs !== null)
    return (
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            Paused until {formatQuietUntil(new Date(quietUntilMs), new Date())}
          </ItemTitle>
          <ItemDescription>
            {isWebPushAvailable()
              ? "Alerts resume on their own then, even with Cue closed."
              : "Notifications on this device resume on their own then."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="outline" onClick={resumeWebNotifications}>
            Resume
          </Button>
        </ItemActions>
      </Item>
    );

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>Pause notifications</ItemTitle>
        <ItemDescription>
          Silence new-mail alerts on this device for a while.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <PausePicker />
      </ItemActions>
    </Item>
  );
}

function PausePicker() {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState<{ value: string; until: Date | null }>({
    value: "",
    until: null,
  });
  const now = new Date();

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setShowCustom(false);
      setCustom({ value: "", until: null });
    }
  };
  const choose = (until: Date) => {
    onOpenChange(false);
    pauseWebNotifications(until.getTime());
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          Pause…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Pause notifications until"
        className="w-72 p-1"
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
                aria-label="Pause until date and time"
                className="mt-2 w-full rounded-md border border-input bg-background p-2 text-foreground text-sm"
                max={toDateTimeLocal(new Date(now.getTime() + MAX_QUIET_MS))}
                min={toDateTimeLocal(now)}
                onChange={(event) =>
                  setCustom({
                    value: event.target.value,
                    until: validPauseEnd(event.target.value),
                  })
                }
                type="datetime-local"
                value={custom.value}
              />
            </label>
            <Button
              className="w-full"
              disabled={!custom.until}
              onClick={() => {
                // Checked again: the picker may have stayed open a while.
                const until = validPauseEnd(custom.value);
                if (until) choose(until);
                else setCustom({ value: custom.value, until: null });
              }}
              size="sm"
              type="button"
            >
              Pause
            </Button>
          </div>
        ) : (
          <>
            {getQuietPresets(now).map((preset) => (
              <Button
                className="flex h-9 w-full justify-between gap-3 px-2 font-normal text-xs"
                key={preset.id}
                onClick={() => choose(preset.until)}
                type="button"
                variant="ghost"
              >
                <span>{preset.label}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatQuietUntil(preset.until, now)}
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

/** A time to pause until, if it is ahead of now and within the limit. */
function validPauseEnd(value: string) {
  if (!value) return null;
  const until = new Date(value);
  const ms = until.getTime();
  const now = Date.now();
  if (Number.isNaN(ms) || ms <= now || ms > now + MAX_QUIET_MS) return null;
  return until;
}

function toDateTimeLocal(date: Date) {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}
