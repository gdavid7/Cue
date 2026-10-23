import { escapeHtml } from "@/utils/string";

type FreeTimeSlot = { startTime: string; endTime: string };

/**
 * The reply text for "Share my free times": each opening in the account's
 * time zone, labelled with that zone's name on its own date (so a list that
 * crosses a clock change says EDT then EST), then the booking link.
 * Returns null when there is nothing true to say.
 */
export function formatFreeTimesHtml({
  slots,
  timezone,
  bookingLink,
}: {
  slots: FreeTimeSlot[];
  timezone: string;
  bookingLink: string | null;
}): string | null {
  const parts: string[] = [];

  if (slots.length) {
    const items = slots
      .map(
        (slot) => `<li>${escapeHtml(formatFreeTimeSlot(slot, timezone))}</li>`,
      )
      .join("");
    parts.push(
      `<p>Here are a few times that work for me:</p><ul>${items}</ul>`,
    );
  }

  if (bookingLink) {
    const href = escapeHtml(bookingLink);
    const link = `<a href="${href}">${href}</a>`;
    parts.push(
      slots.length
        ? `<p>Or book a time here: ${link}</p>`
        : `<p>You can book a time here: ${link}</p>`,
    );
  }

  return parts.length ? parts.join("") : null;
}

export function formatFreeTimeSlot(slot: FreeTimeSlot, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  // ICU puts narrow and thin spaces around times; some mail clients show
  // them as boxes.
  return formatter
    .formatRange(new Date(slot.startTime), new Date(slot.endTime))
    .replace(/[   ]/g, " ");
}
