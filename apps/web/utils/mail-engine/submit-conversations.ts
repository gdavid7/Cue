import chunk from "lodash/chunk";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  MetadataChange,
  SubmitConversationCommand,
} from "@inboxzero/mail-core/commands";
import type { LocalRevision } from "@inboxzero/mail-core/identities";
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

async function submitWithObservedRevision(
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
