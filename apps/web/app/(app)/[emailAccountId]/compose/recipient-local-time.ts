import { extractEmailAddress } from "@/utils/email";
import { parseDateHeaderOffsetMinutes } from "@/utils/email/date-header-offset";
import { GmailLabel } from "@/utils/gmail/label";

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The UTC offset in each sender's latest message in the thread, by lowercase
 * address. A sender whose latest message gave no offset maps to null:
 * an older message's offset may be from before they moved or travelled.
 */
export function getLatestSenderOffsets(
  messages: {
    headers: { from: string; date: string };
    labelIds?: string[] | null;
  }[],
) {
  const latest = new Map<string, { sentAt: number; date: string }>();
  for (const { headers, labelIds } of messages) {
    if (
      labelIds?.includes(GmailLabel.DRAFT) ||
      labelIds?.includes(GmailLabel.SENT)
    )
      continue;
    const address = extractEmailAddress(headers.from).toLowerCase();
    const sentAt = Date.parse(headers.date);
    if (!address || !Number.isFinite(sentAt)) continue;
    const current = latest.get(address);
    if (!current || sentAt > current.sentAt)
      latest.set(address, { sentAt, date: headers.date });
  }
  return Object.fromEntries(
    [...latest].map(([address, { date }]) => [
      address,
      parseDateHeaderOffsetMinutes(date) ?? null,
    ]),
  );
}

/**
 * The recipient's clock, read from the offset their last message was written
 * in. Null unless the reply goes to exactly one person whose offset is known,
 * differs from the user's, and is not zero: some servers rewrite every Date
 * header to UTC, so zero says nothing reliable about where they are.
 */
export function getRecipientLocalTime({
  recipients,
  senderOffsets,
  ownOffsetMinutes,
  now,
}: {
  recipients: string[];
  senderOffsets: Record<string, number | null>;
  ownOffsetMinutes: number;
  now: Date;
}) {
  if (recipients.length !== 1) return null;
  const offsetMinutes = senderOffsets[recipients[0].toLowerCase()];
  if (
    offsetMinutes == null ||
    offsetMinutes === 0 ||
    offsetMinutes === ownOffsetMinutes
  )
    return null;
  // Their wall clock, held in a Date's UTC fields.
  const theirs = new Date(now.getTime() + offsetMinutes * MINUTE_MS);
  const hour = theirs.getUTCHours();
  const morning = new Date(theirs);
  morning.setUTCHours(DAY_START_HOUR, 0, 0, 0);
  if (morning.getTime() <= theirs.getTime())
    morning.setTime(morning.getTime() + DAY_MS);
  return {
    offsetMinutes,
    now,
    outsideDay: hour < DAY_START_HOUR || hour >= DAY_END_HOUR,
    nextMorning: new Date(morning.getTime() - offsetMinutes * MINUTE_MS),
  };
}

/** The time on their clock at an instant, in the user's own time format. */
export function formatTheirTime(
  instant: Date,
  offsetMinutes: number,
  locale?: string,
) {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })
    .formatToParts(new Date(instant.getTime() + offsetMinutes * MINUTE_MS))
    .map((part) => {
      if (part.type === "dayPeriod") return part.value.toLowerCase();
      // ICU puts a narrow no-break space before "AM"; read it as a space.
      return part.type === "literal"
        ? part.value.replace(/\s/gu, " ")
        : part.value;
    })
    .join("");
}
