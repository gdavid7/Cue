import type { MetadataChange } from "@inboxzero/mail-core/commands";
import { GmailLabel } from "@/utils/gmail/label";

export type ThreadMutationPayload =
  | { kind: "archive"; labelId?: string }
  | { kind: "unarchive" }
  | { kind: "trash" }
  | { kind: "untrash" }
  | { kind: "spam" }
  | { kind: "not_spam" }
  | { kind: "set_important_state"; important: boolean }
  | { kind: "set_read_state"; read: boolean }
  | { kind: "set_starred_state"; starred: boolean }
  | { kind: "snooze"; scheduledFor: string }
  /** An Outlook folder; Gmail has none. */
  | { kind: "move_to_folder"; folderId: string };

export function mutationPayloadToChange(
  payload: ThreadMutationPayload,
): MetadataChange | null {
  switch (payload.kind) {
    case "archive":
      return { kind: "archive" };
    case "unarchive":
      return { kind: "unarchive" };
    case "trash":
      return { kind: "trash" };
    case "untrash":
      return { kind: "restore_from_trash" };
    case "spam":
      return { kind: "set_spam", spam: true };
    case "not_spam":
      return { kind: "set_spam", spam: false };
    case "set_important_state":
      // Gmail's own IMPORTANT label. Outlook has no matching membership.
      return {
        kind: "set_membership",
        membership: "label",
        id: GmailLabel.IMPORTANT,
        present: payload.important,
      };
    case "set_read_state":
      return { kind: "set_read", read: payload.read };
    case "set_starred_state":
      return { kind: "set_starred", starred: payload.starred };
    case "snooze":
      return {
        kind: "snooze",
        untilMs: Date.parse(payload.scheduledFor),
      };
    case "move_to_folder":
      return { kind: "move", folderId: payload.folderId };
    default:
      return null;
  }
}
