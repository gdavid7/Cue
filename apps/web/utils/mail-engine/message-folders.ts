import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { ConversationKey } from "@inboxzero/mail-core/identities";
import type { ConversationView } from "@inboxzero/mail-core/ports/mail-store";

/** Where one message was before a move, so undo can put it back. */
export type MessageFolder = {
  messageId: string;
  folderId: string | null;
  inbox: boolean;
};

const PAGE_SIZE = 200;

/**
 * Where each of a conversation's stored messages is now, as the engine has
 * it. The engine keeps no record of where a moved message came from, so a
 * move reads this first for its undo.
 */
export async function readMessageFolders(
  client: MailClient,
  key: ConversationKey,
): Promise<MessageFolder[]> {
  const folders: MessageFolder[] = [];
  let after: string | null = null;
  do {
    const view = await readConversationPage(client, key, after);
    for (const message of view.messages) {
      folders.push({
        messageId: message.key.messageId,
        folderId: message.metadata.folderId,
        inbox: message.metadata.roles.includes("inbox"),
      });
    }
    after = view.nextPage;
  } while (after);
  return folders;
}

/**
 * The changes that return moved messages to where they were, one per place.
 * Inbox mail goes back with `unarchive`, so the inbox shows it again at once
 * rather than once the provider confirms which folder is the inbox.
 */
export function moveBackChanges(
  messages: readonly MessageFolder[],
  movedToFolderId: string,
) {
  const groups = new Map<
    string,
    { change: MetadataChange; messageIds: string[] }
  >();
  const add = (key: string, change: MetadataChange, messageId: string) => {
    const group = groups.get(key) ?? { change, messageIds: [] };
    group.messageIds.push(messageId);
    groups.set(key, group);
  };
  for (const message of messages) {
    if (message.inbox) {
      add("inbox", { kind: "unarchive" }, message.messageId);
    } else if (message.folderId && message.folderId !== movedToFolderId) {
      add(
        `folder:${message.folderId}`,
        { kind: "move", folderId: message.folderId },
        message.messageId,
      );
    }
  }
  return [...groups.values()];
}

function readConversationPage(
  client: MailClient,
  key: ConversationKey,
  after: string | null,
): Promise<ConversationView> {
  return new Promise((resolve, reject) => {
    const handle = client.observeConversation(key, {
      after,
      pageSize: PAGE_SIZE,
    });
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = () => {
      const snapshot = handle.getSnapshot();
      if (settled || snapshot.status === "loading") return;
      settled = true;
      unsubscribe?.();
      handle.close();
      if (snapshot.status === "ready" && snapshot.data) resolve(snapshot.data);
      else reject(new Error(snapshot.error?.code ?? snapshot.status));
    };
    unsubscribe = handle.subscribe(settle);
    settle();
  });
}
