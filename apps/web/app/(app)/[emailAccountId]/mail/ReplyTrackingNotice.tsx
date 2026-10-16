"use client";

import {
  CueNoticeStatus,
  replyTrackingOffNotice,
} from "@/app/(app)/[emailAccountId]/home/CueNotice";
import { useMailSettings } from "@/hooks/useMailSettings";
import { useAccount } from "@/providers/EmailAccountProvider";

/**
 * Today's "Reply tracking is off" line, in Mail too: people live in the inbox,
 * so a mailbox Cue isn't sorting shouldn't look like one with nothing to do.
 */
export function ReplyTrackingNotice() {
  const { emailAccountId } = useAccount();
  const { data: settings } = useMailSettings();

  // Only an explicit false: settings cached before the field existed omit it.
  if (settings?.replyTracking !== false) return null;

  return (
    <div className="shrink-0 px-5 pt-3">
      <CueNoticeStatus notice={replyTrackingOffNotice(emailAccountId)} />
    </div>
  );
}
