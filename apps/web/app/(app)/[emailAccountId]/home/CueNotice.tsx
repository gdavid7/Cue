import Link from "next/link";
import { type LucideIcon, PauseIcon } from "lucide-react";
import { prefixPath } from "@/utils/path";
import { TodayStatus } from "./TodayStatus";

/** Why Cue can't yet say what needs a reply. */
export type CueNotice = {
  icon: LucideIcon;
  /** Settings that are off are nags, quieter than what Cue is doing. */
  tone: "info" | "quiet";
  title: string;
  detail?: string;
  link?: { label: string; href: string };
};

/**
 * Shown on Today and in Mail, so a mailbox without it never looks sorted.
 * Across accounts it names the mailbox it is about.
 */
export function replyTrackingOffNotice(
  emailAccountId: string,
  accountEmail?: string,
): CueNotice {
  return {
    icon: PauseIcon,
    tone: "quiet",
    title: accountEmail
      ? `Reply tracking is off for ${accountEmail}, so Cue isn't checking what needs a reply.`
      : "Reply tracking is off, so Cue isn't checking what needs a reply.",
    link: {
      label: "Turn it on in Rules",
      href: prefixPath(emailAccountId, "/automation"),
    },
  };
}

export function CueNoticeStatus({ notice }: { notice: CueNotice }) {
  return (
    <TodayStatus icon={notice.icon} title={notice.title} tone={notice.tone}>
      {notice.detail}
      {notice.link ? (
        <Link
          className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
          href={notice.link.href}
        >
          {notice.link.label}
        </Link>
      ) : null}
    </TodayStatus>
  );
}
