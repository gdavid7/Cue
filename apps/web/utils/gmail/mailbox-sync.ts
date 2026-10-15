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
// A catch-up reads the history backlog first, at 2 units a call, so it can
// fetch the most recently changed messages first: new mail shows after one
// small fetch instead of after every older change has been replayed under the
// account's Gmail quota. The scan stops once it holds enough unfetched
// messages, which keeps the cursor that carries them (at most 400 ids, about
// 10 KB) inside the protocol's 16 KB checkpoint.
const HISTORY_SCAN_PAGE_SIZE = 100;
const HISTORY_SCAN_MAX_CALLS = 20;
const HISTORY_SCAN_MAX_MESSAGES = 300;
// About 200 units, which the quota gate admits within a second or so.
const DELTA_FIRST_FETCH_SIZE = 10;
const DELTA_FETCH_PAGE_SIZE = 25;

type GmailDeltaCursor = Extract<MailboxSyncCursor, { provider: "google" }>;

export async function getGmailMailboxSyncPage({
  gmail,
  accessToken,
  logger,
  cursor,
  after,
  limit,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  cursor?: string;
  after?: Date;
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

  if (decoded.pending?.length) {
    return fetchDeltaMessages({
      gmail,
      accessToken,
      logger,
      cursor: decoded,
      upsertIds: decoded.pending,
      deletedIds: new Set(),
      changedThreadIds: new Set(),
      count: Math.min(limit, DELTA_FETCH_PAGE_SIZE),
    });
  }

  try {
    const scan = await scanGmailHistory({ gmail, logger, cursor: decoded });
    return await fetchDeltaMessages({
      gmail,
      accessToken,
      logger,
      cursor: {
        ...decoded,
        historyId: scan.historyId,
        pageToken: scan.pageToken,
      },
      ...scan.changes,
      count: Math.min(limit, DELTA_FIRST_FETCH_SIZE),
    });
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

async function scanGmailHistory({
  gmail,
  logger,
  cursor,
}: {
  gmail: gmail_v1.Gmail;
  logger: Logger;
  cursor: GmailDeltaCursor;
}) {
  const history: gmail_v1.Schema$History[] = [];
  let pageToken = cursor.pageToken;
  let historyId = cursor.historyId;
  for (let call = 0; call < HISTORY_SCAN_MAX_CALLS; call++) {
    const response = await getHistory(
      gmail,
      {
        startHistoryId: cursor.historyId,
        historyTypes: [...GMAIL_MAILBOX_HISTORY_TYPES],
        maxResults: HISTORY_SCAN_PAGE_SIZE,
        pageToken,
      },
      logger,
    );
    history.push(...(response.history ?? []));
    pageToken = response.nextPageToken ?? undefined;
    if (!pageToken) {
      historyId = response.historyId ?? cursor.historyId;
      break;
    }
    if (
      getGmailMailboxChangeIds(history).upsertIds.length >=
      HISTORY_SCAN_MAX_MESSAGES
    )
      break;
  }
  const changes = getGmailMailboxChangeIds(history);
  return {
    historyId,
    pageToken,
    changes: {
      ...changes,
      upsertIds: newestChangeFirst(changes.upsertIds, history),
    },
  };
}

async function fetchDeltaMessages({
  gmail,
  accessToken,
  logger,
  cursor,
  upsertIds,
  deletedIds,
  changedThreadIds,
  count,
}: {
  gmail: gmail_v1.Gmail;
  accessToken: string;
  logger: Logger;
  cursor: GmailDeltaCursor;
  upsertIds: string[];
  deletedIds: Set<string>;
  changedThreadIds: Set<string>;
  count: number;
}): Promise<MailboxSyncPage> {
  const batch = upsertIds.slice(0, count);
  const pending = upsertIds.slice(count);
  const fetched = await getGmailSyncMessages({
    gmail,
    messageIds: batch,
    accessToken,
    logger,
  });
  const fetchedMessages = fetched.messages.map(compactMailboxSyncMessage);
  const afterTimestamp = new Date(cursor.after).getTime();
  const upsertedMessages = fetchedMessages.filter((message) => {
    const inTimeWindow = Number(message.internalDate) >= afterTimestamp;
    if (!inTimeWindow) deletedIds.add(message.id);
    return inTimeWindow;
  });
  const fetchedIds = new Set(fetchedMessages.map((message) => message.id));
  for (const messageId of batch) {
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
      pending: pending.length > 0 ? pending : undefined,
    }),
    changedThreadIds: [...changedThreadIds],
    deletedMessageIds: [...deletedIds],
    hasMore: pending.length > 0 || Boolean(cursor.pageToken),
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
