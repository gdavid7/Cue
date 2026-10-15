import { describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import { encodeMailboxSyncCursor } from "@/utils/email/mailbox-sync";
import { getHistory } from "@/utils/gmail/history";
import { getGmailMailboxSyncPage } from "@/utils/gmail/mailbox-sync";
import { getMessage, getMessagesBatch } from "@/utils/gmail/message";

vi.mock("@/utils/gmail/history");
vi.mock("@/utils/gmail/message");

const logger = createTestLogger();
// What one sync page may carry (packages/mail-core/src/sync.ts).
const MAX_PAGE_CHANGES = 1000;
const MAX_CHECKPOINT_LENGTH = 16_384;

// A mailbox changes while Cue is closed, then keeps changing during the
// catch-up. Whatever the backlog, the first page must show the newest mail,
// every page must fit the protocol, and the local copy must end up equal to
// Gmail.
// Records naming 50 or 150 messages (thread-wide changes) exercise shrinking
// and splitting replay pages; their 7000-change backlogs also converge but
// take minutes, so they run with shorter backlogs here.
describe.each([
  { perRecord: 1, backlogs: [5, 300, 7000] },
  { perRecord: 5, backlogs: [5, 300, 7000] },
  { perRecord: 20, backlogs: [5, 300, 7000] },
  { perRecord: 50, backlogs: [5, 300] },
  { perRecord: 150, backlogs: [5, 300] },
])("Gmail delta catch-up, $perRecord messages per record", ({
  perRecord,
  backlogs,
}) => {
  it.each(
    backlogs,
  )("converges after a backlog of %i changes", async (backlog) => {
    const gmail = simulatedGmail(
      perRecord,
      seededRandom(backlog * 10 + perRecord),
    );
    for (let index = 0; index < 20; index++) gmail.add();
    const local = new Map<string, { label: string; version: number }>();
    for (const [id, state] of gmail.truth)
      local.set(id, { label: `L${state.label}`, version: state.version });
    let cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: String(gmail.historyId()),
      after: "2000-01-01T00:00:00.000Z",
    });
    const startHistoryId = gmail.historyId();
    for (let index = 0; index < backlog; index++) gmail.mutate();
    // Messages added by one record arrive together; a preview may hold only
    // some of them.
    const newest =
      gmail.records
        .filter((record) => record.kind === "add" && record.id > startHistoryId)
        .at(-1)?.messages ?? [];

    const apply = (
      page: Awaited<ReturnType<typeof getGmailMailboxSyncPage>>,
    ) => {
      expect(
        page.upsertedMessages.length + page.deletedMessageIds.length,
      ).toBeLessThanOrEqual(MAX_PAGE_CHANGES);
      expect(page.cursor.length).toBeLessThanOrEqual(MAX_CHECKPOINT_LENGTH);
      for (const message of page.upsertedMessages) {
        const version = Number(message.historyId);
        const current = local.get(message.id);
        if (current && current.version > version) continue;
        local.set(message.id, { label: message.labelIds?.[0] ?? "", version });
      }
      for (const id of page.deletedMessageIds) local.delete(id);
    };
    let pages = 0;
    let firstPageHasNewest = false;
    for (let round = 0; round < 3; round++) {
      let page: Awaited<ReturnType<typeof getGmailMailboxSyncPage>>;
      do {
        page = await getGmailMailboxSyncPage({
          gmail: gmail.client as never,
          accessToken: "access-token",
          logger,
          cursor,
          limit: 50,
          includeBodies: true,
        });
        if (pages === 0) {
          const live = newest.filter((id) => gmail.truth.has(id));
          firstPageHasNewest =
            live.length === 0 ||
            page.upsertedMessages.some((message) => live.includes(message.id));
        }
        pages += 1;
        apply(page);
        cursor = page.cursor;
        if (pages % 3 === 0) gmail.mutate();
        if (pages > 50_000) throw new Error("catch-up did not finish");
      } while (page.hasMore);
    }
    apply(
      await getGmailMailboxSyncPage({
        gmail: gmail.client as never,
        accessToken: "access-token",
        logger,
        cursor,
        limit: 50,
      }),
    );

    expect(firstPageHasNewest).toBe(true);
    expect(new Map([...local].map(([id, value]) => [id, value.label]))).toEqual(
      new Map([...gmail.truth].map(([id, state]) => [id, `L${state.label}`])),
    );
  }, 120_000);
});

type HistoryRecord = {
  id: number;
  messages: string[];
  kind: "add" | "label" | "delete";
};

function simulatedGmail(perRecord: number, random: () => number) {
  let historyId = 1000;
  let nextMessage = 0;
  const records: HistoryRecord[] = [];
  const truth = new Map<
    string,
    { label: number; version: number; date: number }
  >();
  const add = () => {
    const messages = Array.from(
      { length: perRecord },
      () => `m${(nextMessage++).toString().padStart(14, "0")}`,
    );
    historyId += 1;
    for (const id of messages)
      truth.set(id, {
        label: 0,
        version: historyId,
        date: 1_900_000_000_000 + nextMessage,
      });
    records.push({ id: historyId, messages, kind: "add" });
  };
  const pick = () => {
    const live = [...truth.keys()];
    return live[Math.floor(random() * live.length)];
  };
  const label = () => {
    const id = pick();
    if (!id) return add();
    historyId += 1;
    const state = truth.get(id);
    if (state) {
      state.label += 1;
      state.version = historyId;
    }
    records.push({ id: historyId, messages: [id], kind: "label" });
  };
  const remove = () => {
    const id = pick();
    if (!id) return add();
    historyId += 1;
    truth.delete(id);
    records.push({ id: historyId, messages: [id], kind: "delete" });
  };
  const mutate = () => {
    const roll = random();
    if (roll < 0.5) add();
    else if (roll < 0.85) label();
    else remove();
  };
  vi.mocked(getHistory).mockImplementation(async (_gmail, options) => {
    const eligible = records.filter(
      (record) => record.id > Number(options.startHistoryId),
    );
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    const max = options.maxResults ?? 100;
    const slice = eligible.slice(offset, offset + max);
    return {
      history: slice.map((record) => {
        const changes = record.messages.map((id) => ({
          message: { id, threadId: id },
        }));
        return {
          id: String(record.id),
          messages: record.messages.map((id) => ({ id, threadId: id })),
          ...(record.kind === "add" && { messagesAdded: changes }),
          ...(record.kind === "label" && { labelsAdded: changes }),
          ...(record.kind === "delete" && { messagesDeleted: changes }),
        };
      }),
      historyId: String(historyId),
      nextPageToken:
        offset + max < eligible.length ? String(offset + max) : undefined,
    };
  });
  vi.mocked(getMessagesBatch).mockImplementation(async ({ messageIds }) =>
    messageIds.flatMap((id) => {
      const state = truth.get(id);
      if (!state) return [];
      return [
        {
          ...getMockMessage({ id, labelIds: [`L${state.label}`] }),
          historyId: String(state.version),
          internalDate: String(state.date),
        },
      ];
    }),
  );
  vi.mocked(getMessage).mockRejectedValue({ status: 404 });
  const client = {
    users: {
      getProfile: vi.fn(async () => ({
        data: { historyId: String(historyId) },
      })),
      messages: {
        list: vi.fn(async () => ({
          data: {
            messages: [...truth.entries()]
              .sort((a, b) => b[1].date - a[1].date)
              .slice(0, 10)
              .map(([id]) => ({ id })),
          },
        })),
      },
    },
  };
  return {
    add,
    mutate,
    truth,
    records,
    client,
    historyId: () => historyId,
  };
}

// Deterministic, so a failure reproduces.
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
