import "server-only";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { createEmailProvider } from "@/utils/email/provider";
import { runWithGmailQuota } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { resolveNativeThreadsQuery } from "@/utils/split-inbox/native-categories";
import { loadThreads, toListThreads } from "@/utils/threads/load";
import { threadsQuery } from "@/utils/threads/validation";

const logger = createScopedLogger("mail/inbox-preview");

/**
 * The inbox's newest conversations, as the mail list shows them, for a
 * browser that has no local mailbox for the account yet. Someone is waiting
 * on it, so it runs at interactive Gmail priority. Resolves null rather than
 * failing the page; the list then waits for the mail engine as before.
 */
export async function loadInboxPreview({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string;
}): Promise<ThreadsListResponse | null> {
  const log = logger.with({ emailAccountId });
  try {
    return await runWithGmailQuota(
      { caller: "mail/inbox-preview", priority: "interactive" },
      async () => {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger: log,
        });
        const query = await resolveNativeThreadsQuery({
          emailAccountId,
          emailProvider,
          query: threadsQuery.parse({ type: "inbox", limit: 25 }),
        });
        return toListThreads(
          await loadThreads({
            query,
            emailAccountId,
            emailProvider,
            messageFormat: "metadata",
          }),
        );
      },
    );
  } catch (error) {
    log.warn("Could not load the inbox preview", { error });
    return null;
  }
}
