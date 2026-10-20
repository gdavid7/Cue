import "server-only";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailThread } from "@/utils/email/types";
import {
  getGmailCallDeferredError,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { GMAIL_RECENT_WINDOW_MS } from "@/utils/mail-api/source";
import { parsedMessagePatch } from "@/utils/mail-api/observations";
import { sleep } from "@/utils/sleep";
import { attachThreadPlans, toListThreads } from "@/utils/threads/load";
import type { ParsedMessage } from "@/utils/types";

const logger = createScopedLogger("mail/inbox-preview");

// About the first screen of the inbox, read as its newest messages: a list
// (5 Gmail units) and ten message reads (20 each), about 205 units in two
// batches that fit Gmail's per-second pace. Whole threads cost 40 units each,
// 410 for ten, more than two seconds of that pace before anything else on
// the account is counted. The mail engine fills in the rest as it syncs.
// Reading a tab ahead, for a new mailbox only, is a second such list, read
// alongside the first.
const PREVIEW_MESSAGES = 10;
// A mailbox days behind has a screen of new mail, not a handful: 20
// messages are about 405 units, inside one second of interactive pace.
const CATCH_UP_PREVIEW_MESSAGES = 20;
// The page's shell is sent before this settles; only the stream stays open
// for the rows. Past these, the list waits for the mail engine instead.
const MAX_QUOTA_WAIT_MS = 4000;
// The gate defers a call that would wait past the budget above, often by
// only a second. A deferral this short is waited out once, so a new user's
// first rows don't fall back to the slower mail engine over it.
const MAX_DEFERRAL_WAIT_MS = 2500;
const PREVIEW_TIMEOUT_MS = 5000 + MAX_DEFERRAL_WAIT_MS;

export type InboxPreview = ThreadsListResponse & {
  /** The same messages as the mail engine records them, to hand it. */
  changes: ProviderChange[];
  /** The tab the rows are the newest of, or null for the whole inbox. */
  splitId: string | null;
};

/**
 * The inbox's newest conversations, as the mail list shows them, for a
 * browser that has no local mailbox for the account yet, and the messages
 * they were read from for its mail engine, so the rows can be acted on as
 * soon as the engine starts rather than after its first sync. Someone is
 * waiting on it, so it runs at interactive Gmail priority. Resolves null
 * rather than failing or holding up the page.
 */
export async function loadInboxPreview({
  emailAccountId,
  provider,
  tab,
  readAhead,
  catchUp = false,
}: {
  emailAccountId: string;
  provider: string;
  /**
   * The Gmail tab the inbox opens on, such as Primary, by its labels. Its own
   * newest mail, since the whole inbox's newest is mostly other tabs'.
   */
  tab?: { splitId: string; labelIds: string[] };
  /** Labels of a Gmail tab the inbox may open on next, read for the engine only. */
  readAhead?: string[];
  /** For a local mailbox that has fallen behind, rather than none. */
  catchUp?: boolean;
}): Promise<InboxPreview | null> {
  const log = logger.with({ emailAccountId });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const gaveUp = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      log.warn("Gave up on the inbox preview");
      resolve(null);
    }, PREVIEW_TIMEOUT_MS);
  });
  const load = ({ withReadAhead }: { withReadAhead: boolean }) =>
    runWithGmailQuota(
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
        const readNewest = (labelIds?: string[]) =>
          emailProvider
            .getMessagesWithPagination({
              ...(labelIds ? { labelIds } : { inboxOnly: true }),
              maxResults: catchUp
                ? CATCH_UP_PREVIEW_MESSAGES
                : PREVIEW_MESSAGES,
              format: "metadata",
              allowPartial: true,
            })
            .then((page) => page.messages);
        const [messages, readAheadMessages] = await Promise.all([
          readNewest(tab?.labelIds),
          // A guess at what opens next: it never costs the rows shown now.
          readAhead && withReadAhead
            ? readNewest(readAhead).catch((error: unknown) => {
                log.warn("Could not read ahead for the inbox preview", {
                  error,
                });
                return [];
              })
            : [],
        ]);
        const list = toListThreads(
          await attachThreadPlans({
            emailAccountId,
            threads: groupByThread(messages),
          }),
        );
        const shown = new Set(messages.map((message) => message.id));
        // A tab's newest mail can be weeks old. The engine gets only what its
        // first sync covers too: older mail would sit apart from the mail
        // around it in All, and one archived elsewhere since could come back.
        const firstSyncFromMs = Date.now() - GMAIL_RECENT_WINDOW_MS;
        const inFirstSync = (message: ParsedMessage) =>
          Number(message.internalDate) >= firstSyncFromMs;
        const handedOver = [
          ...(tab ? messages.filter(inFirstSync) : messages),
          ...readAheadMessages.filter(
            (message) => !shown.has(message.id) && inFirstSync(message),
          ),
        ];
        // Outlook's engine reads its mail by folder, which these rows
        // were not read by, so only Gmail's are handed over.
        return {
          ...list,
          splitId: tab?.splitId ?? null,
          changes:
            emailProvider.name === "google"
              ? handedOver.map((message) =>
                  metadataPatch(emailAccountId, message),
                )
              : [],
        };
      },
    );
  const loaded = load({ withReadAhead: true })
    .catch(async (error: unknown) => {
      const deferred = getGmailCallDeferredError(error);
      if (!deferred || deferred.retryAfterMs > MAX_DEFERRAL_WAIT_MS)
        throw error;
      log.info("Inbox preview deferred by Gmail quota; waiting it out", {
        retryAfterMs: deferred.retryAfterMs,
      });
      await sleep(deferred.retryAfterMs);
      // Nobody is waiting for rows any more; leave the quota to the engine.
      if (timedOut) return null;
      // The retry is for the rows shown now; reading ahead can wait for the engine.
      return load({ withReadAhead: false });
    })
    .catch((error: unknown) => {
      log.warn("Could not load the inbox preview", { error });
      return null;
    });
  try {
    return await Promise.race([loaded, gaveUp]);
  } finally {
    clearTimeout(timeout);
  }
}

// A metadata read has no parts to find attachments in, so its patch leaves
// the flag to the engine's own reads rather than clearing it.
function metadataPatch(emailAccountId: string, message: ParsedMessage) {
  const patch = parsedMessagePatch(emailAccountId, "google", message);
  if (patch.kind !== "message_patch") return patch;
  const { hasAttachments: _unknown, ...fields } = patch.fields;
  return { ...patch, fields };
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
