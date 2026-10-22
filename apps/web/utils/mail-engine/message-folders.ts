import maxBy from "lodash/maxBy";
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
 * Where each of a conversation's messages is now, as the engine has it. The
 * engine keeps no record of where a moved message came from, so a move reads
 * this first for its undo. Messages not stored yet would be moved without a
 * record, so the whole conversation is fetched first, or this fails.
 */
export async function readMessageFolders(
  client: MailClient,
  key: ConversationKey,
): Promise<MessageFolder[]> {
  const completion = await client.ensureConversationMessages(key);
  if (completion.status !== "complete") {
    throw new Error("conversation_incomplete");
  }
  return readStoredMessageFolders(client, key);
}

/** Where each of a conversation's stored messages is now. */
export async function readStoredMessageFolders(
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
 * rather than once the provider confirms which folder is the inbox. Messages
 * now in the folder that the move's read never saw go where most of the
 * conversation came from.
 */
export function moveBackChanges(
  messages: readonly MessageFolder[],
  movedToFolderId: string,
  current: readonly MessageFolder[] = [],
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
  const dominant = maxBy(
    [...groups.values()],
    (group) => group.messageIds.length,
  );
  if (dominant) {
    const seen = new Set(messages.map((message) => message.messageId));
    for (const message of current) {
      if (message.folderId === movedToFolderId && !seen.has(message.messageId))
        dominant.messageIds.push(message.messageId);
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
