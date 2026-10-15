import type { gmail_v1 } from "@googleapis/gmail";
import {
  compactMailboxSyncMessage,
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
  type MailboxSyncCursor,
} from "@/utils/email/mailbox-sync";
import type { MailboxSyncPage } from "@/utils/email/types";
import { getGmailSyncMessages } from "@/utils/gmail/sync-messages";
import { getHistory } from "@/utils/gmail/history";
import { extractErrorInfo, withGmailRetry } from "@/utils/gmail/retry";
import type { Logger } from "@/utils/logger";

// Archive, read, and star are label events. Gmail does not treat archive as
// messagesDeleted, so mailbox delta sync must ask for labelRemoved explicitly.
const GMAIL_MAILBOX_HISTORY_TYPES = [
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
] as const;
// A catch-up after time away replays history oldest first, which under the
// account's Gmail quota can take minutes. Before each replay page, a preview
// reads history past what was already previewed, at 2 units a call, and
// fetches only the newest changes, so new mail shows first whatever the
// backlog's size. The replay fetches previewed messages again; the store drops
// a version it already has.
const HISTORY_SCAN_PAGE_SIZE = 500;
const HISTORY_SCAN_MAX_CALLS = 10;
// About 200 units, which the quota gate admits within a second or so.
const PREVIEW_SIZE = 10;
// A backlog this small is applied whole in one page, well inside the 1000
// changes a sync page may carry.
const SHORT_CATCH_UP_MAX_CHANGES = 500;

type GmailDeltaCursor = Extract<MailboxSyncCursor, { provider: "google" }>;

export async function getGmailMailboxSyncPage({
  gmail,
  accessToken,
  logger,
  cursor,
  after,
  includeBodies = false,
  limit,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  cursor?: string;
  after?: Date;
  includeBodies?: boolean;
  limit: number;
}): Promise<MailboxSyncPage> {
  if (!cursor) {
    if (!after) throw new Error("after is required for initial mailbox sync");
    return getGmailSnapshotPage({
      gmail,
      accessToken,
      logger,
      after,
      limit,
      reset: true,
    });
  }

  const decoded = decodeMailboxSyncCursor(cursor, "google");
  if (decoded.phase === "snapshot") {
    return getGmailSnapshotPage({
      gmail,
      accessToken,
      logger,
      after: new Date(decoded.after),
      historyId: decoded.historyId,
      pageToken: decoded.pageToken,
      limit,
      reset: false,
    });
  }

  try {
    const page = await getGmailDeltaPage({
      gmail,
      accessToken,
      logger,
      cursor: decoded,
      limit,
    });
    // The delta fetched each message in full, so a caller that stores bodies
    // keeps them rather than fetching every message a second time.
    if (includeBodies) return { ...page, includesBodies: true };
    return {
      ...page,
      upsertedMessages: page.upsertedMessages.map(compactMailboxSyncMessage),
    };
  } catch (error) {
    if (extractErrorInfo(error).status !== 404) throw error;

    return getGmailSnapshotPage({
      gmail,
      accessToken,
      logger,
      after: new Date(decoded.after),
      limit,
      reset: true,
    });
  }
}

export async function advanceGmailMailboxSyncCursor({
  gmail,
  logger,
  cursor,
}: {
  gmail: gmail_v1.Gmail;
  logger: Logger;
  cursor: string;
}): Promise<string | null> {
  const decoded = decodeMailboxSyncCursor(cursor, "google");
  try {
    const response = await getHistory(
      gmail,
      { startHistoryId: decoded.historyId, maxResults: 1 },
      logger,
    );
    return encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: response.historyId ?? decoded.historyId,
      after: decoded.after,
    });
  } catch (error) {
    if (extractErrorInfo(error).status !== 404) throw error;
    return null;
  }
}

// Every Gmail delta read: past a preview of the newest changes, one page of
// history replayed oldest first. The preview is what lets new mail win: the
// replay of a long backlog can take minutes under the account's quota.
async function getGmailDeltaPage({
  gmail,
  accessToken,
  logger,
  cursor,
  limit,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  cursor: GmailDeltaCursor;
  limit: number;
}): Promise<MailboxSyncPage> {
  const marker = cursor.previewedThrough;
  const preview = await scanGmailHistory({
    gmail,
    logger,
    startHistoryId: marker ?? cursor.historyId,
    pageToken: marker ? undefined : cursor.pageToken,
  });
  if (
    !marker &&
    preview.historyId &&
    preview.changes.upsertIds.length <= PREVIEW_SIZE &&
    preview.changes.upsertIds.length + preview.changes.deletedIds.size <=
      SHORT_CATCH_UP_MAX_CHANGES
  ) {
    // The preview holds the whole backlog, so it is the catch-up.
    return fetchDeltaPage({
      gmail,
      accessToken,
      logger,
      ...preview.changes,
      cursor: {
        ...cursor,
        historyId: preview.historyId,
        pageToken: undefined,
        previewedThrough: undefined,
      },
    });
  }
  const previewed = preview.historyId
    ? {
        upsertIds: preview.changes.upsertIds.slice(0, PREVIEW_SIZE),
        through: preview.historyId,
      }
    : await newestGmailMessages({ gmail, logger, after: cursor.after });
  // A preview carries only its few newest messages. Deletions, which can number
  // thousands after Trash is emptied, wait for the replay's bounded pages.
  if (!marker) {
    return fetchDeltaPage({
      gmail,
      accessToken,
      logger,
      upsertIds: previewed.upsertIds,
      deletedIds: new Set(),
      changedThreadIds: new Set(),
      cursor: { ...cursor, previewedThrough: previewed.through },
    });
  }

  const response = await getHistory(
    gmail,
    {
      startHistoryId: cursor.historyId,
      historyTypes: [...GMAIL_MAILBOX_HISTORY_TYPES],
      maxResults: limit,
      pageToken: cursor.pageToken,
    },
    logger,
  );
  const replay = getGmailMailboxChangeIds(response.history ?? []);
  const deletedIds = replay.deletedIds;
  const pageToken = response.nextPageToken ?? undefined;
  return fetchDeltaPage({
    gmail,
    accessToken,
    logger,
    upsertIds: [
      ...new Set([...previewed.upsertIds, ...replay.upsertIds]),
    ].filter((id) => !deletedIds.has(id)),
    deletedIds,
    changedThreadIds: replay.changedThreadIds,
    // The replay's end is the mailbox's current history, past the preview.
    cursor: pageToken
      ? { ...cursor, pageToken, previewedThrough: previewed.through }
      : {
          ...cursor,
          historyId: response.historyId ?? cursor.historyId,
          pageToken: undefined,
          previewedThrough: undefined,
        },
  });
}

// Reads history to its end, at 2 units a call, newest change first. A backlog
// too long to read within the bound returns no historyId.
async function scanGmailHistory({
  gmail,
  logger,
  startHistoryId,
  pageToken,
}: {
  gmail: gmail_v1.Gmail;
  logger: Logger;
  startHistoryId: string;
  pageToken: string | undefined;
}) {
  const history: gmail_v1.Schema$History[] = [];
  let historyId: string | null = null;
  let nextPageToken = pageToken;
  for (let call = 0; call < HISTORY_SCAN_MAX_CALLS; call++) {
    const response = await getHistory(
      gmail,
      {
        startHistoryId,
        historyTypes: [...GMAIL_MAILBOX_HISTORY_TYPES],
        maxResults: HISTORY_SCAN_PAGE_SIZE,
        pageToken: nextPageToken,
      },
      logger,
    );
    history.push(...(response.history ?? []));
    nextPageToken = response.nextPageToken ?? undefined;
    if (!nextPageToken) {
      historyId = response.historyId ?? startHistoryId;
      break;
    }
  }
  const changes = getGmailMailboxChangeIds(history);
  return {
    historyId,
    changes: {
      ...changes,
      upsertIds: newestChangeFirst(changes.upsertIds, history),
    },
  };
}

// For a backlog too long to scan: the mailbox's newest messages, and the
// history they are current as of, taken first so nothing after it is missed.
async function newestGmailMessages({
  gmail,
  logger,
  after,
}: {
  gmail: gmail_v1.Gmail;
  logger: Logger;
  after: string;
}) {
  const profile = await withGmailRetry(
    () => gmail.users.getProfile({ userId: "me" }),
    5,
    { logger },
  );
  const through = profile.data.historyId;
  if (!through) throw new Error("Gmail did not return a mailbox history ID");
  const response = await withGmailRetry(
    () =>
      gmail.users.messages.list({
        userId: "me",
        q: `after:${Math.floor(new Date(after).getTime() / 1000)}`,
        maxResults: PREVIEW_SIZE,
      }),
    5,
    { logger },
  );
  return {
    upsertIds: (response.data.messages ?? []).flatMap((message) =>
      message.id ? [message.id] : [],
    ),
    through,
  };
}

async function fetchDeltaPage({
  gmail,
  accessToken,
  logger,
  cursor,
  upsertIds,
  deletedIds,
  changedThreadIds,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  cursor: GmailDeltaCursor;
  upsertIds: string[];
  deletedIds: Set<string>;
  changedThreadIds: Set<string>;
}): Promise<MailboxSyncPage> {
  const fetched = await getGmailSyncMessages({
    gmail,
    messageIds: upsertIds,
    accessToken,
    logger,
  });
  const fetchedMessages = fetched.messages;
  const afterTimestamp = new Date(cursor.after).getTime();
  const upsertedMessages = fetchedMessages.filter((message) => {
    const inTimeWindow = Number(message.internalDate) >= afterTimestamp;
    if (!inTimeWindow) deletedIds.add(message.id);
    return inTimeWindow;
  });
  const fetchedIds = new Set(fetchedMessages.map((message) => message.id));
  for (const messageId of upsertIds) {
    if (!fetchedIds.has(messageId)) deletedIds.add(messageId);
  }

  return {
    cursor: encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: cursor.historyId,
      after: cursor.after,
      pageToken: cursor.pageToken,
      previewedThrough: cursor.previewedThrough,
    }),
    changedThreadIds: [...changedThreadIds],
    deletedMessageIds: [...deletedIds],
    hasMore: Boolean(cursor.pageToken || cursor.previewedThrough),
    reset: false,
    upsertedMessages,
  };
}

// Orders message ids by the latest history record that touched each one,
// newest first, keeping their order within a record.
function newestChangeFirst(
  messageIds: string[],
  history: gmail_v1.Schema$History[],
) {
  const lastTouched = new Map<string, number>();
  history.forEach((record, index) => {
    const touched = [
      ...(record.messagesAdded ?? []),
      ...(record.labelsAdded ?? []),
      ...(record.labelsRemoved ?? []),
    ].map((change) => change.message);
    for (const message of [...touched, ...(record.messages ?? [])]) {
      if (message?.id) lastTouched.set(message.id, index);
    }
  });
  return [...messageIds].sort(
    (a, b) => (lastTouched.get(b) ?? -1) - (lastTouched.get(a) ?? -1),
  );
}

export function getGmailMailboxChangeIds(history: gmail_v1.Schema$History[]): {
  upsertIds: string[];
  deletedIds: Set<string>;
  changedThreadIds: Set<string>;
} {
  const upsertIds = new Set<string>();
  const deletedIds = new Set<string>();
  const changedThreadIds = new Set<string>();

  for (const record of history) {
    for (const change of [
      ...(record.messagesAdded ?? []),
      ...(record.messagesDeleted ?? []),
      ...(record.labelsAdded ?? []),
      ...(record.labelsRemoved ?? []),
    ]) {
      if (change.message?.threadId)
        changedThreadIds.add(change.message.threadId);
    }
    for (const change of record.messagesAdded ?? []) {
      if (change.message?.id) upsertIds.add(change.message.id);
    }
    for (const change of record.labelsAdded ?? []) {
      if (change.message?.id) upsertIds.add(change.message.id);
    }
    for (const change of record.labelsRemoved ?? []) {
      if (change.message?.id) upsertIds.add(change.message.id);
    }
    for (const change of record.messagesDeleted ?? []) {
      if (change.message?.id) deletedIds.add(change.message.id);
    }
    // Typed arrays can be omitted; the summary `messages` list still names
    // every affected id so current labels can be written to the cache.
    for (const message of record.messages ?? []) {
      if (message.threadId) changedThreadIds.add(message.threadId);
      if (message.id) upsertIds.add(message.id);
    }
  }

  for (const messageId of deletedIds) upsertIds.delete(messageId);
  return { upsertIds: [...upsertIds], deletedIds, changedThreadIds };
}

async function getGmailSnapshotPage({
  gmail,
  accessToken,
  logger,
  after,
  limit,
  reset,
  historyId,
  pageToken,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  after: Date;
  limit: number;
  reset: boolean;
  historyId?: string;
  pageToken?: string;
}): Promise<MailboxSyncPage> {
  const snapshotHistoryId =
    historyId ??
    (
      await withGmailRetry(() => gmail.users.getProfile({ userId: "me" }), 5, {
        logger,
      })
    ).data.historyId;
  if (!snapshotHistoryId) {
    throw new Error("Gmail did not return a mailbox history ID");
  }

  const response = await withGmailRetry(
    () =>
      gmail.users.messages.list({
        userId: "me",
        q: `after:${Math.floor(after.getTime() / 1000)}`,
        maxResults: limit,
        pageToken,
      }),
    5,
    { logger },
  );
  const fetched = await getGmailSyncMessages({
    gmail,
    messageIds: (response.data.messages ?? []).flatMap((message) =>
      message.id ? [message.id] : [],
    ),
    accessToken,
    logger,
  });
  const nextPageToken = response.data.nextPageToken ?? undefined;

  return {
    cursor: encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: nextPageToken ? "snapshot" : "delta",
      historyId: snapshotHistoryId,
      after: after.toISOString(),
      pageToken: nextPageToken,
    }),
    deletedMessageIds: [],
    hasMore: true,
    reset,
    upsertedMessages: fetched.messages.map(compactMailboxSyncMessage),
  };
}
