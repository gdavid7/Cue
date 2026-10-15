import "server-only";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { createEmailProvider } from "@/utils/email/provider";
import { runWithGmailQuota } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { resolveNativeThreadsQuery } from "@/utils/split-inbox/native-categories";
import { loadThreads, toListThreads } from "@/utils/threads/load";
import { threadsQuery } from "@/utils/threads/validation";

const logger = createScopedLogger("mail/inbox-preview");

// About the first screen of the inbox. The list and ten messages fit Gmail's
// per-second pacing; the mail engine fills in the rest as it syncs.
const PREVIEW_CONVERSATIONS = 10;
// The page streams until this settles, so a slow or busy provider is given up
// on: the list then waits for the mail engine as it did before.
const MAX_QUOTA_WAIT_MS = 2500;
const PREVIEW_TIMEOUT_MS = 3000;

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
    timeout = setTimeout(() => resolve(null), PREVIEW_TIMEOUT_MS);
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
      const query = await resolveNativeThreadsQuery({
        emailAccountId,
        emailProvider,
        query: threadsQuery.parse({
          type: "inbox",
          limit: PREVIEW_CONVERSATIONS,
        }),
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
