import {
  MAX_UTC_OFFSET_MINUTES,
  MIN_UTC_OFFSET_MINUTES,
} from "@inboxzero/mail-core/messages";

const RFC_5322_ZONE =
  /\d{1,2}:\d{2}(?::\d{2})?\s+(?:([+-])(\d{2})(\d{2})|(UT|GMT|Z))(?:\s*\(.*\))?\s*$/i;
const ISO_ZONE =
  /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:([+-])(\d{2}):(\d{2})|Z)$/i;

/**
 * The UTC offset, in minutes, a Date header was written in: the sender's
 * clock when they sent it, which is a hint about their time zone and never
 * proof of it. Undefined when the header names no usable numeric zone.
 */
export function parseDateHeaderOffsetMinutes(
  value: string | null | undefined,
): number | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return;
  const match = value.trim().match(RFC_5322_ZONE) ?? value.match(ISO_ZONE);
  if (!match) return;
  const [, sign, hours, minutes] = match;
  if (!sign) return 0;
  // RFC 5322: -0000 says the sender's zone is unknown, unlike +0000.
  if (sign === "-" && hours === "00" && minutes === "00") return;
  const minutePart = Number(minutes);
  // Every real zone sits on a quarter hour.
  if (minutePart >= 60 || minutePart % 15 !== 0) return;
  const offset = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + minutePart);
  if (offset < MIN_UTC_OFFSET_MINUTES || offset > MAX_UTC_OFFSET_MINUTES)
    return;
  return offset;
}

/** An ISO date for the instant, written in the given offset when known. */
export function formatDateWithUtcOffset(
  ms: number,
  offsetMinutes: number | undefined,
) {
  if (offsetMinutes === undefined) return new Date(ms).toISOString();
  const local = new Date(ms + offsetMinutes * 60_000).toISOString();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${local.slice(0, -1)}${sign}${hours}:${minutes}`;
}
