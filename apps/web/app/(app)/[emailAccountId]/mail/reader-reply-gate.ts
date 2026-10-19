import {
  canWriteRequestedReplies,
  type DraftRepliesSetting,
} from "@/utils/rule/draft-replies-enabled";

/**
 * What the reader may do about a reply to the newest message.
 * - `canRequest`: someone else wrote it and there's no draft yet.
 * - `writesReplies`: asking gets Cue's draft, not just an empty composer. Only
 *   the user's explicit "Auto draft replies" off stops that. While the setting
 *   loads it's assumed allowed, so the button doesn't change its mind once it
 *   arrives; the server checks again.
 * - `autoEligible`: Cue may draft without being asked, which needs the
 *   setting on (never having chosen counts as on). Whether the mail needs a
 *   reply is decided separately.
 */
export function getReaderReplyGate({
  setting,
  settingLoading,
  hasLatest,
  latestIsFromUser,
  hasDraft,
}: {
  setting: DraftRepliesSetting;
  settingLoading: boolean;
  hasLatest: boolean;
  latestIsFromUser: boolean;
  hasDraft: boolean;
}) {
  const canRequest = hasLatest && !latestIsFromUser && !hasDraft;
  return {
    canRequest,
    writesReplies: settingLoading || canWriteRequestedReplies(setting),
    autoEligible: !settingLoading && setting === "on" && canRequest,
  };
}
