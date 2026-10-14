import { SystemType } from "@/generated/prisma/enums";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";
import { GmailLabel } from "@/utils/gmail/label";
import { getRuleLabel } from "@/utils/rule/consts";

const MAX_PARTS = 3;

export type InsightLine = {
  /**
   * "ready": a checked reply is waiting. "action": something is on the user.
   * "pending": blocked on someone else or on missing information. "info": worth knowing.
   */
  tone: "ready" | "action" | "pending" | "info";
  parts: string[];
};

type ThreadForInsight = {
  messages: {
    labelIds?: string[] | null;
    internalDate?: string | null;
    headers: { from: string; to: string };
  }[];
};

/**
 * The line under an inbox row, or null. Silence is the default: a note on
 * every row stops being read, so a part is added only when it changes what
 * the user would do. Reply status is read from the thread's live labels, the
 * rest comes from the server.
 */
export function composeInsight({
  thread,
  labelNames,
  userEmail,
  data,
  now = new Date(),
}: {
  thread: ThreadForInsight;
  /** Label id to name, for the thread's labels. */
  labelNames: (labelId: string) => string | undefined;
  userEmail: string;
  data: ThreadInsightData | undefined;
  now?: Date;
}): InsightLine | null {
  // The user's unsent draft doesn't change whose move it is.
  const latest =
    thread.messages.findLast(
      (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
    ) ?? thread.messages.at(-1);
  if (!latest) return null;
  const names = new Set(
    thread.messages.flatMap((m) =>
      (m.labelIds ?? []).map((id) => labelNames(id)).filter(Boolean),
    ),
  );
  const userWroteLast =
    extractEmailAddress(latest.headers.from).toLowerCase() ===
    userEmail.toLowerCase();

  const parts: string[] = [];
  let tone: InsightLine["tone"] = "info";
  const insight = data?.insight;
  const when = insight?.date ? formatWhen(insight.date, now) : null;

  // The reply's state leads, so "ready", "blocked" and "to do" don't look alike.
  if (data?.reply === "ready") {
    tone = "ready";
    parts.push("Reply ready");
  } else if (data?.reply === "needs-info") {
    tone = "pending";
    parts.push("Needs info to reply");
  }

  if (insight && insight.action !== "none" && insight.task) {
    if (tone === "info") tone = "action";
    parts.push(capitalize(insight.task));
    if (when && insight.dateRole === "deadline") parts.push(`due ${when}`);
  } else if (
    !data?.reply &&
    !userWroteLast &&
    names.has(getRuleLabel(SystemType.TO_REPLY))
  ) {
    tone = "action";
    parts.push("Needs your reply");
  } else if (
    userWroteLast &&
    names.has(getRuleLabel(SystemType.AWAITING_REPLY))
  ) {
    tone = "pending";
    const days = Math.floor(
      (now.getTime() - Number(latest.internalDate ?? now.getTime())) /
        86_400_000,
    );
    const to = latest.headers.to.split(",")[0] ?? "";
    const name = extractNameFromEmail(to) || extractEmailAddress(to);
    parts.push(
      days >= 1 ? `Waiting on ${name} · ${days}d` : `Waiting on ${name}`,
    );
  }

  if (when && insight && insight.dateRole !== "deadline") {
    if (insight.dateRole === "expires") parts.push(`Ends ${when}`);
    if (insight.dateRole === "event") parts.push(capitalize(when));
  } else if (when && insight?.action === "none") {
    parts.push(`Due ${when}`);
  }
  if (insight?.fact) {
    parts.push(
      insight.factLabel ? `${insight.factLabel} ${insight.fact}` : insight.fact,
    );
  }
  if (data?.meeting) {
    parts.push(
      `Meeting with ${firstName(data.meeting.with)} ${formatWhen(data.meeting.at, now)}`,
    );
  }
  return parts.length ? { tone, parts: parts.slice(0, MAX_PARTS) } : null;
}

/** "today 5 PM", "tomorrow", "Thu", "Oct 16": short, and in the user's own time zone. */
export function formatWhen(iso: string, now: Date) {
  const hasTime = iso.includes("T");
  // A bare date is a calendar day where the user is, not midnight UTC.
  const date = hasTime ? new Date(iso) : localDate(iso);
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000,
  );
  const time = hasTime
    ? ` ${date
        .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        .replace(":00", "")}`
    : "";
  if (days === 0) return `today${time}`;
  if (days === 1) return `tomorrow${time}`;
  if (days > 1 && days < 7)
    return `${date.toLocaleDateString("en-US", { weekday: "short" })}${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${time}`;
}

function localDate(isoDate: string) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function firstName(name: string) {
  return name.includes("@") ? name : (name.split(" ")[0] ?? name);
}
