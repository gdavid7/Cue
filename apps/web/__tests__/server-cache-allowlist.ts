/**
 * Every place apps/web writes to Redis or keeps a server-side cache, and what
 * each key holds. RD-3: no email content or personal data in a server cache:
 * no addresses, names, subjects, snippets, bodies, attachment names, AI text
 * derived from mail, research, contact photos, linked pages or meeting
 * details. Only opaque ids, counters, locks, hashes, timestamps, enums and
 * booleans.
 *
 * `writes` is how many write sites server-cache-guard.test.ts finds in the
 * file. A new one fails that test until its key is recorded here; record what
 * the value holds, not what the code does.
 */
type CacheKey = {
  key: string;
  holds: string;
  ttl: string;
};

export const SERVER_CACHE_WRITES: Record<
  string,
  { writes: number; keys: CacheKey[] }
> = {
  "app/api/labels/counts/route.ts": {
    writes: 1,
    keys: [
      {
        key: "label-counts:{emailAccountId}",
        holds:
          "Gmail label ids, kinds and thread/unread counts; names are read back from Gmail",
        ttl: "60s",
      },
    ],
  },
  "utils/ai/assistant/chat-matching-actions.ts": {
    writes: 2,
    keys: [
      {
        key: "assistant-matching-confirm:{emailAccountId}:{confirmToken}",
        holds:
          "a chat id, tool call id, bulk-action enum, optional label id and an HMAC (server secret) of the search; never the search itself",
        ttl: "15m, taken once by Confirm or Cancel; put back with its remaining TTL only if the job fails to start",
      },
    ],
  },
  "utils/ai/assistant/local-mail-search.ts": {
    writes: 3,
    keys: [
      {
        key: "assistant-local-search:{emailAccountId}:{requestId}",
        holds:
          '"pending", then the message and thread ids the browser matched, or for a count per-account totals, top groups (count, newest message id, month/week or label-id key) and the newest message ids; or an unavailable reason enum',
        ttl: "10s, deleted once read",
      },
    ],
  },
  "utils/ai/draft-cleanup.ts": {
    writes: 1,
    keys: [
      {
        key: "draft-cleanup:cursor",
        holds: "the last email account id swept",
        ttl: "7 days",
      },
    ],
  },
  "utils/analytics/activation.ts": {
    writes: 1,
    keys: [
      {
        key: "activation:{event}:{emailAccountId}[:{day}]",
        holds: '"1", a once-only claim',
        ttl: "per event",
      },
    ],
  },
  "utils/analytics/first-hour-health.ts": {
    writes: 1,
    keys: [
      {
        key: "activation:first-hour-health:{emailAccountId}",
        holds: '"1", sent once',
        ttl: "3 days",
      },
    ],
  },
  "utils/analytics/server-conversions.ts": {
    writes: 1,
    keys: [
      {
        key: "conversion:{provider}:{event}:{userId}:{timestamp}",
        holds: '"1", a dedupe claim',
        ttl: "24h",
      },
    ],
  },
  "utils/chat/active-run.ts": {
    writes: 3,
    keys: [
      {
        key: "assistant-chat:stop (pub/sub channel)",
        holds:
          "a chat stream id; replies are not resumable, so no reply text crosses Redis",
        ttl: "not stored",
      },
    ],
  },
  "utils/digest/summary-limit.ts": {
    writes: 1,
    keys: [
      {
        key: "digest:summary-limit:{emailAccountId}",
        holds: "reservation ids scored by timestamp",
        ttl: "24h window",
      },
    ],
  },
  "utils/email/local-mail-sync-budget.ts": {
    writes: 6,
    keys: [
      {
        key: "local-mail-budget:{provider}:*",
        holds: "token-bucket counters, owner tokens and timestamps",
        ttl: "seconds to minutes",
      },
    ],
  },
  "utils/gmail/quota-store.ts": {
    writes: 7,
    keys: [
      {
        key: "gmail-quota:{emailAccountId}:*",
        holds: "quota units, budgets, block deadlines and usage counters",
        ttl: "seconds to minutes",
      },
    ],
  },
  "utils/home/meeting-news.ts": {
    writes: 1,
    keys: [
      {
        key: "meeting-news:{sha256(organization)}",
        holds:
          "public headlines (title, url, domain, date) about an organization, shared by all users; the key is hashed so it doesn't say whom anyone meets",
        ttl: "4h",
      },
    ],
  },
  "utils/home/next-up.ts": {
    writes: 2,
    keys: [
      {
        key: "home-deadlines-paused:{app}:{emailAccountId}",
        holds: '"1" while a connected app is down or slow',
        ttl: "5 min",
      },
      {
        key: "asana-task-list:{emailAccountId}",
        holds: "the Asana task list gid",
        ttl: "7 days",
      },
    ],
  },
  "utils/llms/model-usage-guard.ts": {
    writes: 5,
    keys: [
      {
        key: "memo spendUnreadable {userId}:{sha256(addresses)}",
        holds: "the error from a failed spend read (instance memory)",
        ttl: "30s",
      },
      {
        key: "memo weeklySpendByBucket {userId}:{sha256(addresses)}",
        holds: "weekly spend in dollars per bucket (instance memory)",
        ttl: "60s",
      },
      {
        key: "memo spendBucketWarnings",
        holds: "booleans (instance memory)",
        ttl: "1h",
      },
      {
        key: "trial-ai-limit-notification:{userId}",
        holds: "a timestamp",
        ttl: "60 days",
      },
      {
        key: "ai-spend-bucket-over-limit:{bucket}:{userId}:{week}",
        holds: "a timestamp",
        ttl: "8 days",
      },
    ],
  },
  "utils/log-error-with-dedupe.ts": {
    writes: 5,
    keys: [
      {
        key: "log-dedupe:v1:{seen|count|summary}:{sha256 prefix}",
        holds: '"1" flags and a suppressed-count integer',
        ttl: "per caller",
      },
    ],
  },
  "utils/mailbox-push.ts": {
    writes: 1,
    keys: [
      {
        key: "mailbox-push-cooldown:{emailAccountId}",
        holds: '"1", a cooldown claim',
        ttl: "MAILBOX_PUSH_COOLDOWN_SECONDS",
      },
    ],
  },
  "utils/mcp/providers/composio.ts": {
    writes: 4,
    keys: [
      {
        key: "composio-pending-connection:{connectedAccountId} / by starter",
        holds:
          "app slug, email account id and user id; the connected account id",
        ttl: "PENDING_CONNECTION_SECONDS",
      },
      {
        key: "composio auth config / mcp server memo",
        holds: "Composio config ids and server URLs (instance memory)",
        ttl: "instance life",
      },
    ],
  },
  "utils/messaging/chat-sdk/bot.ts": {
    writes: 1,
    keys: [
      {
        key: "Chat SDK state (prefix CHAT_SDK_STATE_KEY_PREFIX)",
        holds:
          "locks, dedupe flags, subscriptions and callback ids; message history and transcripts are dropped by withoutMessageContent",
        ttl: "Chat SDK defaults",
      },
    ],
  },
  "utils/outlook/local-mail-sync.ts": {
    writes: 2,
    keys: [
      {
        key: "local-mail-folder-id:{emailAccountId}:{wellKnownName}",
        holds: "an Outlook folder id or null",
        ttl: "24h",
      },
      {
        key: "local-mail-categories:{emailAccountId}",
        holds:
          "sha256 of each category name mapped to its id (null for an orphan), and a Graph nextLink",
        ttl: "5 min",
      },
    ],
  },
  "utils/posthog.ts": {
    writes: 2,
    keys: [
      {
        key: "posthog:stripe-checkout-created:{checkoutSessionId}",
        holds: '"1", a dedupe claim',
        ttl: "short",
      },
      {
        key: "first-event:{emailAccountId}:{event}",
        holds: '"1", a once-only claim',
        ttl: "none",
      },
    ],
  },
  "utils/queue/bullmq.ts": {
    writes: 1,
    keys: [
      {
        key: "BullMQ queues (self-hosted QUEUE_BACKEND=bullmq only)",
        holds:
          "job payloads from enqueueBackgroundJob: account, run, meeting, invoice and message ids only (audited in RD-3b)",
        ttl: "BullMQ defaults",
      },
    ],
  },
  "utils/rate-limit.ts": {
    writes: 1,
    keys: [
      {
        key: "rate-limit:{scope}:{userId}",
        holds: "a request counter",
        ttl: "the window",
      },
    ],
  },
  "utils/redis/account-validation.ts": {
    writes: 1,
    keys: [
      {
        key: "account-owner:{userId}:{emailAccountId}",
        holds:
          '"1": the account belongs to the user; the address is never cached',
        ttl: "1h, deleted on removal or merge",
      },
    ],
  },
  "utils/redis/categorization-progress.ts": {
    writes: 2,
    keys: [
      {
        key: "categorization-progress:{emailAccountId}",
        holds: "item counts, a status enum and timestamps",
        ttl: "15 min",
      },
    ],
  },
  "utils/redis/clean.ts": {
    writes: 2,
    keys: [
      {
        key: "thread:{emailAccountId}:{jobId}:{threadId} (and the same pub/sub channel)",
        holds:
          "ids, status enum, archive/undone flags and the thread date; the browser looks up sender and subject",
        ttl: "6h",
      },
    ],
  },
  "utils/redis/contact-photos.ts": {
    writes: 1,
    keys: [
      {
        key: "contact-photos-paused:{emailAccountId}",
        holds:
          '"1" after a failed address-book sweep; the photos stay in the browser',
        ttl: "15 min",
      },
    ],
  },
  "utils/redis/draft-attachment-upload.ts": {
    writes: 1,
    keys: [
      {
        key: "draft-attachment-upload:{emailAccountId}:{uploadId}",
        holds:
          "draft and attachment ids, byte counts and the Gmail resumable session URI (users/me/drafts/{id} with an opaque upload_id; no address). A write capability for one upload, kept server-side so the token isn't aimed elsewhere",
        ttl: "1h",
      },
    ],
  },
  "utils/redis/email-provider-rate-limit.ts": {
    writes: 2,
    keys: [
      {
        key: "email-provider-rate-limit:{emailAccountId} (and its instance memo)",
        holds: "provider enum, source label and retry/detected timestamps",
        ttl: "until retryAt",
      },
    ],
  },
  "utils/redis/gmail-history-catch-up.ts": {
    writes: 4,
    keys: [
      {
        key: "gmail-history-catch-up[-target]:{emailAccountId}",
        holds: "a random token; the highest Gmail historyId seen",
        ttl: "GMAIL_HISTORY_CATCH_UP_TTL_SECONDS",
      },
      {
        key: "gmail-history-empty-runs:{emailAccountId}",
        holds: "a counter",
        ttl: "EMPTY_HISTORY_RUNS_TTL_SECONDS",
      },
    ],
  },
  "utils/redis/gmail-history-lease.ts": {
    writes: 1,
    keys: [
      {
        key: "gmail-history-lease:{emailAccountId}",
        holds: "a random lock token",
        ttl: "5 min",
      },
    ],
  },
  "utils/redis/outbound-thread-status.ts": {
    writes: 2,
    keys: [
      {
        key: "reply-tracker:outbound-thread-status:{emailAccountId}:{threadId}:{messageId}",
        holds: 'a random lock token or "processed"',
        ttl: "per call",
      },
    ],
  },
  "utils/redis/predraft-cap.ts": {
    writes: 2,
    keys: [
      {
        key: "predraft-cap:v1:{emailAccountId}:{YYYY-MM-DD}",
        holds: "a counter of the account's reply pre-drafts that UTC day",
        ttl: "2 days",
      },
      {
        key: "predraft-message:v1:{emailAccountId}:{sha256(messageId)}",
        holds: "the value 1, claiming one message for a pre-draft",
        ttl: "2 days",
      },
    ],
  },
  "utils/redis/public-contact-context-lock.ts": {
    writes: 1,
    keys: [
      {
        key: "public-contact-context:v1:lock:{hash(address)}",
        holds: "a random lock token",
        ttl: "2 min",
      },
    ],
  },
  "utils/redis/index.ts": {
    writes: 1,
    keys: [
      {
        key: "the shared Upstash client",
        holds: "writes nothing itself",
        ttl: "n/a",
      },
    ],
  },
  "utils/redis/local-mail-hints.ts": {
    writes: 2,
    keys: [
      {
        key: "local-mail-version:{emailAccountId}",
        holds: "a random version token per provider push (RD-2 poll)",
        ttl: "7 days",
      },
      {
        key: "local-mail:{emailAccountId} (pub/sub channel)",
        holds: '"{}" or {"kind":"trackers"}',
        ttl: "not stored",
      },
    ],
  },
  "utils/redis/mail-bulk-job.ts": {
    writes: 11,
    keys: [
      {
        key: "mail-bulk-job:{jobId}",
        holds:
          "a select-all job's state: account id, action, status, label id, source job id, counts, capped flag, updatedAt; no mail content, no addresses or label names",
        ttl: "24 hours",
      },
      {
        key: "mail-bulk-job:{jobId}:targets",
        holds: "the job's targets as provider message and thread ids",
        ttl: "24 hours",
      },
      {
        key: "mail-bulk-job:{jobId}:conversations",
        holds: "provider thread ids, to count distinct conversations",
        ttl: "24 hours",
      },
    ],
  },
  "utils/redis/message-processing.ts": {
    writes: 8,
    keys: [
      {
        key: "processing-message:{sha256(mailbox address)}:{messageId}",
        holds: 'a lock token, "processed", "true" or "retry:{timestamp}"',
        ttl: "5 min to 8 days",
      },
      {
        key: "processing-message-failures:{sha256(mailbox address)}:{messageId}",
        holds: "a failure count and first-failure timestamp",
        ttl: "8 days",
      },
      {
        key: "reply-tracker:outbound-message:{emailAccountId}:{messageId}",
        holds: 'a lock token or "processed"',
        ttl: "30 min to 30 days",
      },
    ],
  },
  "utils/redis/messaging-link-code.ts": {
    writes: 1,
    keys: [
      {
        key: "messaging-link:{sha256(nonce)}",
        holds: '"used"',
        ttl: "link lifetime",
      },
    ],
  },
  "utils/redis/oauth-code.ts": {
    writes: 3,
    keys: [
      {
        key: "oauth-code:{sha256(code) prefix}",
        holds:
          '"processing", or the callback redirect URL, status and Set-Cookie headers for a duplicate callback: a short-lived session credential, no mail',
        ttl: "seconds",
      },
    ],
  },
  "utils/redis/outlook-rate-limit-catch-up.ts": {
    writes: 1,
    keys: [
      {
        key: "outlook-rate-limit-catch-up:{emailAccountId}",
        holds: "a timestamp",
        ttl: "OUTLOOK_RATE_LIMIT_CATCH_UP_TTL_SECONDS",
      },
    ],
  },
  "utils/redis/owned-lock.ts": {
    writes: 3,
    keys: [
      {
        key: "callers' lock keys (gmail-history-lease, outbound-thread-status, public-contact-research with a hashed address)",
        holds: "a random lock token or a processed status",
        ttl: "per caller",
      },
    ],
  },
  "utils/redis/provider-issue-cleanup.ts": {
    writes: 1,
    keys: [
      {
        key: "provider-issue-cleanup:{emailAccountId}:{reason}",
        holds: "a claim flag",
        ttl: "claim window",
      },
    ],
  },
  "utils/redis/shared-subscriber.ts": {
    writes: 0,
    keys: [
      {
        key: "shared pub/sub subscriber",
        holds: "subscribes only",
        ttl: "n/a",
      },
    ],
  },
  "utils/redis/subscriber.ts": {
    writes: 1,
    keys: [
      {
        key: "ioredis subscriber connection",
        holds: "writes nothing itself",
        ttl: "n/a",
      },
    ],
  },
  "utils/actions/admin.ts": {
    writes: 1,
    keys: [
      {
        key: "the keys the PII cleanup rewrites (usage-migration:weekly-usage-cost-user:{userId}:done)",
        holds:
          "per-day cost totals; the cleanup only removes the address-keyed form",
        ttl: "none",
      },
    ],
  },
  "utils/redis/pii-cache-keys.ts": {
    writes: 2,
    keys: [
      {
        key: "usage-migration:weekly-usage-cost-user:{userId}:done (rewrite)",
        holds: "per-day cost totals, without addresses",
        ttl: "none",
      },
      {
        key: "processing-message:{sha256(mailbox address)}:{messageId} (rename)",
        holds: "a settled processing flag, moved from the address-keyed key",
        ttl: "kept from the renamed key",
      },
    ],
  },
  "utils/redis/usage.ts": {
    writes: 14,
    keys: [
      {
        key: "usage:{email-account|user}:{id}",
        holds: "token, call and cost counters",
        ttl: "none",
      },
      {
        key: "usage-weekly-cost:user:{userId}:{day}",
        holds: "cost and triage-cost totals",
        ttl: "8 days",
      },
      {
        key: "usage-migration:{name}:{lock|done}",
        holds: "a timestamp lock; migrated counter totals",
        ttl: "none",
      },
    ],
  },
  "utils/team-comments/events.ts": {
    writes: 2,
    keys: [
      {
        key: "team-comments:{conversationId} (pub/sub channel)",
        holds: '"{}", an invalidation',
        ttl: "not stored",
      },
    ],
  },
  "utils/thread-context/connector-context.ts": {
    writes: 5,
    keys: [
      {
        key: "connector-search-failures:{connectionId}",
        holds: "a failure count",
        ttl: "FAILED_SOURCE_COOLDOWN_SECONDS",
      },
      {
        key: "jira-cloud-id:{sha256(site)}",
        holds: "the Atlassian cloud id",
        ttl: "JIRA_CLOUD_ID_CACHE_SECONDS",
      },
      {
        key: "hubspot-portal-id:{connectionId} / salesforce-instance:{connectionId}",
        holds: "the connected account's portal id or instance URL",
        ttl: "CONNECTION_DETAIL_CACHE_SECONDS",
      },
      {
        key: "canvas-user-id:{emailAccountId} / canvas-course-codes:{emailAccountId}",
        holds: "Canvas user id; course context codes like course_123",
        ttl: "Canvas cache constants",
      },
    ],
  },
  "utils/webhook/google/history-catch-up.ts": {
    writes: 1,
    keys: [
      {
        key: "gmail-history-nudge:{emailAccountId}",
        holds: "a claim flag",
        ttl: "nudge window",
      },
    ],
  },
};

/**
 * Key templates the guard flags for interpolating something that looks like
 * an address or a name, reviewed and found safe. `file: template` → why.
 */
export const KEY_TEMPLATE_EXCEPTIONS: Record<string, string> = {
  "utils/messaging/chat-sdk/bot.ts: `reaction:${event.threadId}:${event.messageId}:${event.user.userId}:${event.emoji.name}`":
    "an id for a reaction event, never a Redis key; the name is the emoji's",
  "utils/outlook/local-mail-sync.ts: `local-mail-folder-id:${input.emailAccountId}:${name}`":
    "name is a well-known Outlook folder (drafts, deleteditems, junkemail, …)",
  "utils/redis/message-processing.ts: `processing-message:${userEmail}:${messageId}`":
    "the pre-RD-3 key, only read and checked for existence until it expires; never written",
  "utils/redis/usage.ts: `usage:${email}`":
    "the pre-RD-3 usage counters, only read to migrate them; never written",
  "utils/redis/usage.ts: `email:${email}`":
    "an in-memory label for a legacy spender, never a Redis key",
  "utils/redis/usage.ts: `usage-migration:${migrationName}:done`":
    "migration names are built from user and account ids",
  "utils/redis/usage.ts: `usage-migration:${migrationName}:lock`":
    "migration names are built from user and account ids",
};
