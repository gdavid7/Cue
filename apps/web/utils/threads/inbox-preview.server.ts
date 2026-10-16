import "server-only";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailThread } from "@/utils/email/types";
import { runWithGmailQuota } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { attachThreadPlans, toListThreads } from "@/utils/threads/load";
import type { ParsedMessage } from "@/utils/types";

const logger = createScopedLogger("mail/inbox-preview");

// About the first screen of the inbox, read as its newest messages: a list
// (5 Gmail units) and ten message reads (20 each), about 205 units in two
// batches that fit Gmail's per-second pace. Whole threads cost 40 units each,
// 410 for ten, more than two seconds of that pace before anything else on
// the account is counted. The mail engine fills in the rest as it syncs.
const PREVIEW_MESSAGES = 10;
// The page's shell is sent before this settles; only the stream stays open
// for the rows. Past these, the list waits for the mail engine instead.
const MAX_QUOTA_WAIT_MS = 4000;
const PREVIEW_TIMEOUT_MS = 5000;

/**
 * The inbox's newest conversations, as the mail list shows them, for a
 * browser that has no local mailbox for the account yet. Someone is waiting
 * on it, so it runs at interactive Gmail priority. Resolves null rather than
 * failing or holding up the page.
 */
export async function loadInboxPreview({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string;
}): Promise<ThreadsListResponse | null> {
  const log = logger.with({ emailAccountId });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      log.warn("Gave up on the inbox preview");
      resolve(null);
    }, PREVIEW_TIMEOUT_MS);
  });
  const loaded = runWithGmailQuota(
    {
      caller: "mail/inbox-preview",
      priority: "interactive",
      maxTotalWaitMs: MAX_QUOTA_WAIT_MS,
    },
    async () => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger: log,
      });
      const { messages } = await emailProvider.getMessagesWithPagination({
        inboxOnly: true,
        maxResults: PREVIEW_MESSAGES,
        format: "metadata",
        allowPartial: true,
      });
      return toListThreads(
        await attachThreadPlans({
          emailAccountId,
          threads: groupByThread(messages),
        }),
      );
    },
  ).catch((error: unknown) => {
    log.warn("Could not load the inbox preview", { error });
    return null;
  });
  try {
    return await Promise.race([loaded, gaveUp]);
  } finally {
    clearTimeout(timeout);
  }
}

// Messages arrive newest first; each conversation lists at its newest and
// keeps its own messages oldest first, as a thread does.
function groupByThread(messages: ParsedMessage[]): EmailThread[] {
  const threads = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const threadMessages = threads.get(message.threadId) ?? [];
    threadMessages.unshift(message);
    threads.set(message.threadId, threadMessages);
  }
  return [...threads].map(([id, threadMessages]) => ({
    id,
    messages: threadMessages,
    snippet: threadMessages.at(-1)?.snippet ?? "",
  }));
}
