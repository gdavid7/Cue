import chunk from "lodash/chunk";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  MetadataChange,
  SubmitConversationCommand,
} from "@inboxzero/mail-core/commands";
import type {
  ConversationKey,
  LocalRevision,
  MessageKey,
} from "@inboxzero/mail-core/identities";
import type { MailboxRole } from "@inboxzero/mail-core/messages";
import { beginOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import { randomUuid } from "@/utils/uuid";

const MAX_CONVERSATIONS_PER_COMMAND = 500;

// The engine only checks that a command was built against the same local
// database, which changes only when the mailbox is wiped or reset. Reusing
// the revision saves an engine round trip before every archive or star.
const observedRevisions = new WeakMap<MailClient, Map<string, LocalRevision>>();

export async function submitConversationChange(input: {
  client: MailClient;
  accountId: string;
  conversationId: string;
  change: MetadataChange;
  commandId?: string;
}) {
  const commandId = input.commandId ?? randomUuid();
  const admission = await submitWithObservedRevision(input.client, {
    accountId: input.accountId,
    commandId,
    conversations: [
      {
        accountId: input.accountId,
        conversationId: input.conversationId,
      },
    ],
    change: input.change,
  });
  return { admission, commandId };
}

// One command per batch lets the engine apply the whole selection in a single
// view refresh and lets the server make one bulk provider call.
export async function submitConversationChanges(input: {
  client: MailClient;
  accountId: string;
  conversationIds: string[];
  change: MetadataChange;
}) {
  const accepted: Array<{ conversationId: string; commandId: string }> = [];
  const rejectionCodes: string[] = [];
  const conversationIds = [...new Set(input.conversationIds)];
  if (!conversationIds.length) return { accepted, rejectionCodes };

  // The server's snooze scheduler tracks one thread per operation.
  const batchSize =
    input.change.kind === "snooze" ? 1 : MAX_CONVERSATIONS_PER_COMMAND;
  for (const batch of chunk(conversationIds, batchSize)) {
    const commandId = randomUuid();
    const admission = await submitWithObservedRevision(input.client, {
      accountId: input.accountId,
      commandId,
      conversations: batch.map((conversationId) => ({
        accountId: input.accountId,
        conversationId,
      })),
      change: input.change,
    });
    if (admission.status === "rejected") {
      rejectionCodes.push(admission.code);
      continue;
    }
    for (const conversationId of batch) {
      accepted.push({ conversationId, commandId });
    }
  }
  return { accepted, rejectionCodes };
}

/**
 * A change made in a view of the user's own mail on a folder-based provider,
 * such as Outlook's Sent Items, reaches the messages that view shows rather
 * than the whole conversation, so one command names those messages. That
 * view's rows stay until the engine settles them, as the overlay leaves Sent
 * and Drafts to it there.
 */
export async function submitMessagesInView(input: {
  client: MailClient;
  accountId: string;
  conversationIds: string[];
  role: Extract<MailboxRole, "sent" | "draft">;
  change: MetadataChange;
}) {
  const conversationIds = [...new Set(input.conversationIds)];
  const targets: MessageKey[] = [];
  const shown: string[] = [];
  for (const conversationId of conversationIds) {
    const messages = await readConversationMessages(input.client, {
      accountId: input.accountId,
      conversationId,
    });
    const inView = messages.filter((message) =>
      message.metadata.roles.includes(input.role),
    );
    if (inView.length === 0) continue;
    shown.push(conversationId);
    targets.push(...inView.map((message) => message.key));
  }
  if (targets.length === 0) {
    return { accepted: [], targets, rejectionCodes: ["invalid"] };
  }
  const commandId = randomUuid();
  const admission = await input.client.submitMetadata({
    accountId: input.accountId,
    commandId,
    targets,
    change: input.change,
  });
  if (admission.status === "rejected") {
    return { accepted: [], targets, rejectionCodes: [admission.code] };
  }
  return {
    accepted: shown.map((conversationId) => ({ conversationId, commandId })),
    targets,
    rejectionCodes: [],
  };
}

async function submitWithObservedRevision(
  client: MailClient,
  command: Omit<SubmitConversationCommand, "observedRevision">,
) {
  // Registered before the first await, so the change shows in the same task
  // as the keypress or click that made it.
  const retire = beginOptimisticTriage(client, {
    accountId: command.accountId,
    conversationIds: command.conversations.map(
      (conversation) => conversation.conversationId,
    ),
    change: command.change,
  });
  try {
    return await submitAgainIfStale(client, command);
  } finally {
    // Admitted, the engine's views already show the change; rejected or
    // failed, the row goes back to how the engine has it.
    retire();
  }
}

async function submitAgainIfStale(
  client: MailClient,
  command: Omit<SubmitConversationCommand, "observedRevision">,
) {
  const remembered = observedRevisions.get(client)?.get(command.accountId);
  const admission = await client.submitConversations({
    ...command,
    observedRevision:
      remembered ?? (await readObservedRevision(client, command.accountId)),
  });
  // A stale revision records nothing, so the same command can go again.
  if (
    remembered &&
    admission.status === "rejected" &&
    admission.code === "stale_selection"
  ) {
    return client.submitConversations({
      ...command,
      observedRevision: await readObservedRevision(client, command.accountId),
    });
  }
  return admission;
}

async function readObservedRevision(client: MailClient, accountId: string) {
  const { revision } = await client.getDiagnostics(accountId);
  const revisions = observedRevisions.get(client) ?? new Map();
  revisions.set(accountId, revision);
  observedRevisions.set(client, revisions);
  return revision;
}

// The view the change was made in already shows these messages, so the
// store has them; a large page reads the whole conversation at once.
const VIEW_CONVERSATION_PAGE_SIZE = 500;

function readConversationMessages(client: MailClient, key: ConversationKey) {
  const handle = client.observeConversation(key, {
    after: null,
    pageSize: VIEW_CONVERSATION_PAGE_SIZE,
  });
  return new Promise<
    NonNullable<ReturnType<typeof handle.getSnapshot>["data"]>["messages"]
  >((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const check = () => {
      const snapshot = handle.getSnapshot();
      if (settled || snapshot.status === "loading") return;
      settled = true;
      unsubscribe?.();
      handle.close();
      resolve(snapshot.data?.messages ?? []);
    };
    unsubscribe = handle.subscribe(check);
    check();
  });
}
