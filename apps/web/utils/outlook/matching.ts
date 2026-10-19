import type {
  MatchingFilter,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import { mapWithConcurrency } from "@/utils/async";
import type { Logger } from "@/utils/logger";
import type { OutlookClient } from "@/utils/outlook/client";
import {
  extractErrorInfo,
  withMicrosoftGraphRetry,
  withMicrosoftGraphWriteRetry,
} from "@/utils/outlook/retry";
import type { OutlookWellKnownFolder } from "@/utils/outlook/thread-search-query";

const FOLDER_BY_VIEW_TYPE: Record<string, OutlookWellKnownFolder> = {
  inbox: "inbox",
  unread: "inbox",
  sent: "sentitems",
  draft: "drafts",
  archive: "archive",
  trash: "deleteditems",
  spam: "junkemail",
};

/**
 * How to list every message an Outlook view or search holds. Folder views
 * filter on the server; a search goes through Graph `$search`, which takes no
 * `$filter`, so its read state is filtered as the messages arrive.
 */
export function outlookMatchingRequest(
  scope: MatchingScope,
  only: MatchingFilter,
):
  | { kind: "list"; endpoint: string; filter: string | undefined }
  | { kind: "search"; query: string; folderKey?: OutlookWellKnownFolder }
  | { kind: "unsupported" } {
  // Categories are message properties Graph can't list a folder by here.
  if (scope.labelId || scope.labelIds?.length) return { kind: "unsupported" };

  if (scope.q) {
    return {
      kind: "search",
      query: scope.q,
      folderKey: only.inInbox ? "inbox" : undefined,
    };
  }

  const type = scope.type ?? "inbox";
  const folder = scope.folderId ?? FOLDER_BY_VIEW_TYPE[type];
  if (!folder && type !== "all" && type !== "starred")
    return { kind: "unsupported" };

  let endpoint = folder
    ? `/me/mailFolders/${encodeURIComponent(folder)}/messages`
    : "/me/messages";
  if (only.inInbox && !folder) endpoint = "/me/mailFolders/inbox/messages";

  const filters: string[] = [];
  if (type === "starred" && !scope.folderId)
    filters.push("flag/flagStatus eq 'flagged'");
  if (scope.isUnread || type === "unread") filters.push("isRead eq false");
  if (only.unread === true) filters.push("isRead eq false");
  if (only.unread === false) filters.push("isRead eq true");

  return {
    kind: "list",
    endpoint,
    filter: filters.length ? filters.join(" and ") : undefined,
  };
}

/**
 * Deletes for good each message that is in Deleted Items when its turn
 * comes, and resolves the ids it deleted. Each message's folder is read right
 * before its delete, so mail restored from Trash after a job listed it, or a
 * selection that reaches past Trash, is left alone.
 */
export async function deleteTrashedOutlookMessagesForever({
  client,
  messageIds,
  deletedItemsFolderId,
  logger,
}: {
  client: ReturnType<OutlookClient["getClient"]>;
  messageIds: string[];
  deletedItemsFolderId: string;
  logger: Logger;
}): Promise<string[]> {
  const deleted: string[] = [];
  await mapWithConcurrency([...new Set(messageIds)], 4, async (messageId) => {
    const path = `/me/messages/${encodeURIComponent(messageId)}`;
    try {
      const message: { parentFolderId?: string | null } =
        await withMicrosoftGraphRetry(
          () => client.api(path).select("parentFolderId").get(),
          logger,
        );
      if (message.parentFolderId !== deletedItemsFolderId) return;
      await withMicrosoftGraphWriteRetry(
        () => client.api(`${path}/permanentDelete`).post({}),
        logger,
      );
      deleted.push(messageId);
    } catch (error) {
      if (extractErrorInfo(error).status !== 404) throw error;
    }
  });
  return deleted;
}

/** Whether a listed message belongs in the set an action changes. */
export function keepMatchingOutlookMessage(
  message: {
    id?: string | null;
    conversationId?: string | null;
    isRead?: boolean | null;
  },
  only: MatchingFilter,
) {
  if (!message.id || !message.conversationId) return false;
  if (only.unread === true) return message.isRead === false;
  if (only.unread === false) return message.isRead === true;
  return true;
}
