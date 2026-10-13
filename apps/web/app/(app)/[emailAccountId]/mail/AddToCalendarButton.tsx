"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarPlusIcon } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { Tooltip } from "@/components/Tooltip";
import { toastError, toastSuccessWithLink } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useInboxInsights } from "@/hooks/useInboxInsights";
import { useSaveDestinations } from "@/hooks/useSaveDestinations";
import { addToCalendarAction } from "@/utils/actions/calendar";
import {
  type CalendarDraft,
  getCalendarDraftFromInsight,
} from "@/utils/calendar/insight-event";
import { getActionErrorMessage } from "@/utils/error";

/**
 * Shown when Cue found an event or deadline in the latest email and a
 * calendar is connected: puts it on the user's own calendar after they check
 * the title and time.
 */
export function AddToCalendarButton({
  emailAccountId,
  threadId,
  messageId,
  subject,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
  subject: string;
}) {
  const { data: destinations } = useSaveDestinations(emailAccountId);
  const insightItems = useMemo(
    () =>
      destinations?.calendar
        ? [{ key: threadId, emailAccountId, threadId, messageId }]
        : [],
    [destinations?.calendar, emailAccountId, threadId, messageId],
  );
  const { data: insights } = useInboxInsights(insightItems);
  const draft = getCalendarDraftFromInsight({
    insight: insights?.[threadId]?.insight,
    subject,
  });

  if (!destinations?.calendar || !draft) return null;

  return (
    <AddToCalendarPopover
      key={`${messageId}:${draft.start}`}
      draft={draft}
      emailAccountId={emailAccountId}
    />
  );
}

function AddToCalendarPopover({
  draft,
  emailAccountId,
}: {
  draft: CalendarDraft;
  emailAccountId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [when, setWhen] = useState(
    draft.allDay ? draft.start : toLocalInputValue(draft.start),
  );
  const { execute, isExecuting } = useAction(
    addToCalendarAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data }) => {
        setOpen(false);
        toastSuccessWithLink({
          description: `Added to calendar: ${data?.title ?? title}`,
          link: data?.eventUrl ? { label: "Open", href: data.eventUrl } : null,
        });
      },
      onError: ({ error }) => {
        toastError({
          title: "Couldn't add to calendar",
          description: getActionErrorMessage(error),
        });
      },
    },
  );

  const times = getTimes({ draft, when });
  const canSubmit = !!title.trim() && !!times && !isExecuting;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip content="Add to calendar">
        <PopoverTrigger asChild>
          <Button aria-label="Add to calendar" size="iconXs" variant="outline">
            <CalendarPlusIcon className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="end"
        aria-label="Add to calendar"
        className="w-72 space-y-3 p-3"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !times) return;
            execute({
              title: title.trim(),
              ...times,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
          }}
        >
          <label className="block text-muted-foreground text-xs">
            Title
            <input
              className="mt-1 w-full rounded-md border border-input bg-background p-2 text-foreground text-sm"
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label className="block text-muted-foreground text-xs">
            {draft.allDay ? "Date (all day)" : "Starts"}
            <input
              className="mt-1 w-full rounded-md border border-input bg-background p-2 text-foreground text-sm"
              onChange={(event) => setWhen(event.target.value)}
              type={draft.allDay ? "date" : "datetime-local"}
              value={when}
            />
          </label>
          <Button
            className="w-full"
            disabled={!canSubmit}
            loading={isExecuting}
            size="sm"
            type="submit"
          >
            Add to calendar
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// Keeps the suggested length when the user moves the start.
function getTimes({ draft, when }: { draft: CalendarDraft; when: string }) {
  if (!when) return null;
  if (draft.allDay) return { start: when, end: null };

  const start = new Date(when);
  if (Number.isNaN(start.getTime())) return null;
  const duration = draft.end
    ? new Date(draft.end).getTime() - new Date(draft.start).getTime()
    : 0;
  return {
    start: start.toISOString(),
    end:
      duration > 0 ? new Date(start.getTime() + duration).toISOString() : null,
  };
}

function toLocalInputValue(iso: string) {
  return format(new Date(iso), "yyyy-MM-dd'T'HH:mm");
}
