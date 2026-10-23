"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import type { EmailEditorHandle } from "@inboxzero/email-editor/web";
import type { GetFreeTimesResponse } from "@/app/api/user/calendar/free-times/route";
import { toastError, toastInfo } from "@/components/Toast";
import { fetchWithAccount } from "@/utils/fetch";
import { formatFreeTimesHtml } from "./free-times-text";

/**
 * "Share my free times": reads the calendar live when asked and puts the next
 * openings (and the booking link) at the caret. It inserts only what the
 * calendar answered; when it can't tell, it says so and inserts nothing.
 */
export function useShareFreeTimes({
  editorRef,
  emailAccountId,
}: {
  editorRef: RefObject<EmailEditorHandle | null>;
  emailAccountId: string;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const inFlight = useRef(false);

  const shareFreeTimes = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsLoading(true);

    try {
      const result = await loadFreeTimes(emailAccountId);
      if (!result) {
        toastError({
          description: "Couldn't read your calendar, so no times were added.",
          action: {
            label: "Try again",
            onClick: () => {
              shareFreeTimes();
            },
          },
        });
        return;
      }

      if (result.status === "no-calendar") {
        if (result.bookingLink) {
          insert(result.bookingLink, []);
          toastInfo({
            title: "Added your booking link",
            description: "Connect a calendar to share free times too.",
          });
          return;
        }
        toastError({
          description: "Connect a calendar to share your free times.",
          action: {
            label: "Open Calendars",
            onClick: () => {
              window.open(`/${emailAccountId}/calendars`, "_blank", "noopener");
            },
          },
        });
        return;
      }

      if (!result.slots.length) {
        const title = `No free times in the next ${result.searchDays} days`;
        if (result.bookingLink) {
          insert(result.bookingLink, []);
          toastInfo({ title, description: "Added your booking link instead." });
          return;
        }
        toastError({ title, description: "Nothing was added." });
        return;
      }

      insert(result.bookingLink, result.slots, result.timezone);
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }

    function insert(
      bookingLink: string | null,
      slots: { startTime: string; endTime: string }[],
      timezone = "UTC",
    ) {
      const html = formatFreeTimesHtml({ slots, timezone, bookingLink });
      if (html) editorRef.current?.insertHtml(html);
    }
  }, [editorRef, emailAccountId]);

  return { shareFreeTimes, isLoading };
}

async function loadFreeTimes(
  emailAccountId: string,
): Promise<GetFreeTimesResponse | null> {
  try {
    const response = await fetchWithAccount({
      url: "/api/user/calendar/free-times",
      emailAccountId,
      init: { cache: "no-store" },
    });
    if (!response.ok) return null;
    return (await response.json()) as GetFreeTimesResponse;
  } catch {
    return null;
  }
}
