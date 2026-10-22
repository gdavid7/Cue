import { describe, expect, it } from "vitest";
import {
  type EffectiveMessage,
  messageMatchesPredicate,
} from "@inboxzero/mail-core/query-semantics";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { getMatchingScope } from "@/app/(app)/[emailAccountId]/mail/select-all-matching";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import type { CueMembership } from "@/utils/split-inbox/cue-filter";
import { createThreadsQueryFilter } from "@/utils/split-inbox/thread-matches-split";
import { threadsQuery } from "@/utils/threads/validation";
import {
  getReadingBulkPlan,
  getReadingRoute,
  getReadingSources,
  getReadingSummary,
  inboxWithoutReadingQuery,
  readingLaneQuery,
} from "./reading-lane";

const NEWSLETTER = "Label_42";
const CUE_NEWSLETTER = "m-cue";
const MEMBERSHIP: CueMembership = {
  TO_REPLY: [],
  NEWSLETTER: [CUE_NEWSLETTER],
  MARKETING: [],
};
const NO_MEMBERSHIP: CueMembership = {
  TO_REPLY: [],
  NEWSLETTER: [],
  MARKETING: [],
};

describe("getReadingRoute", () => {
  const route = (overrides: Partial<Parameters<typeof getReadingRoute>[0]>) =>
    getReadingRoute({
      isReadingView: true,
      isAllAccounts: false,
      readingLabelId: NEWSLETTER,
      hasLaneQuery: true,
      labelsLoading: false,
      labelsFailed: false,
      ...overrides,
    });

  it("shows the lane once the Newsletter label is known", () => {
    expect(route({})).toBe("lane");
  });

  it("never shows the lane's bar over the inbox it falls back to when labels fail", () => {
    expect(
      route({
        readingLabelId: undefined,
        hasLaneQuery: false,
        labelsFailed: true,
      }),
    ).toBe("failed");
  });

  it("shows the lane from Cue's sorting alone, once the labels have had their say", () => {
    expect(route({ readingLabelId: undefined })).toBe("lane");
    expect(route({ readingLabelId: undefined, labelsFailed: true })).toBe(
      "lane",
    );
    expect(route({ readingLabelId: undefined, labelsLoading: true })).toBe(
      "resolving",
    );
  });

  it("waits while labels load", () => {
    expect(route({ readingLabelId: undefined, labelsLoading: true })).toBe(
      "resolving",
    );
  });

  it("goes back to the inbox when nothing names a newsletter, or across accounts", () => {
    expect(route({ readingLabelId: undefined, hasLaneQuery: false })).toBe(
      "redirect",
    );
    expect(route({ isAllAccounts: true })).toBe("redirect");
  });

  it("is off on any other view", () => {
    expect(route({ isReadingView: false })).toBe("off");
  });
});

describe("getReadingBulkPlan", () => {
  it("acts on the loaded rows only when they are all of them", () => {
    expect(getReadingBulkPlan({ hasMore: false, canMatch: true })).toBe(
      "loaded",
    );
    expect(getReadingBulkPlan({ hasMore: true, canMatch: true })).toBe(
      "matching",
    );
    expect(getReadingBulkPlan({ hasMore: true, canMatch: false })).toBe(
      "drain",
    );
  });
});

describe.each([
  ["the label", NEWSLETTER, NO_MEMBERSHIP],
  ["Cue's sorting", undefined, MEMBERSHIP],
  ["the label and Cue's sorting", NEWSLETTER, MEMBERSHIP],
])("the inbox and its Reading lane, by %s", (_, labelId, cueMembership) => {
  const sources = getReadingSources({ labelId, cueMembership });
  const inbox = predicateFor(
    inboxWithoutReadingQuery(sources.inbox),
    cueMembership,
  );
  const lane = predicateFor(readingLaneQuery(sources.lane), cueMembership);
  const newsletter = labelId
    ? { labelIds: [labelId] }
    : { messageId: CUE_NEWSLETTER };
  const shownIn = (fields: Partial<EffectiveMessage>) => {
    const msg = message(fields);
    return {
      inbox: messageMatchesPredicate(msg, inbox),
      lane: messageMatchesPredicate(msg, lane),
    };
  };

  it("shows a newsletter in the inbox only in Reading", () => {
    expect(shownIn({ roles: ["inbox"], ...newsletter })).toEqual({
      inbox: false,
      lane: true,
    });
  });

  it("keeps a newsletter in Reading once it's read, so reading through doesn't lose its place", () => {
    expect(shownIn({ roles: ["inbox"], ...newsletter, read: true })).toEqual({
      inbox: false,
      lane: true,
    });
  });

  it("leaves other inbox mail in the inbox", () => {
    expect(shownIn({ roles: ["inbox"], labelIds: ["Label_1"] })).toEqual({
      inbox: true,
      lane: false,
    });
  });

  it("lets an archived newsletter leave both", () => {
    expect(shownIn({ roles: [], ...newsletter })).toEqual({
      inbox: false,
      lane: false,
    });
  });
});

describe("Reading by the label and Cue's sorting", () => {
  const sources = getReadingSources({
    labelId: NEWSLETTER,
    cueMembership: MEMBERSHIP,
  });

  it("lists a conversation both name once, as the server reads it", () => {
    const query = readingLaneQuery(sources.lane);
    if (!query) throw new Error("expected a lane");
    const matches = createThreadsQueryFilter(query, MEMBERSHIP);
    const both = {
      messages: [
        listMessage(CUE_NEWSLETTER, ["INBOX", NEWSLETTER]),
        listMessage("m-2", ["INBOX", NEWSLETTER]),
      ],
    };
    const labelOnly = { messages: [listMessage("m-3", ["INBOX", NEWSLETTER])] };
    const cueOnly = { messages: [listMessage(CUE_NEWSLETTER, ["INBOX"])] };
    const other = { messages: [listMessage("m-4", ["INBOX"])] };
    expect([both, labelOnly, cueOnly, other].map(matches)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("acts on all of the lane through the engine, as no mailbox search can express Cue's sorting", () => {
    const query = readingLaneQuery(sources.lane);
    if (!query) throw new Error("expected a lane");
    expect(getMatchingScope(query, "google")).toBeNull();
    expect(getReadingBulkPlan({ hasMore: true, canMatch: false })).toBe(
      "drain",
    );
  });

  it("keeps the label's own job when Cue sorted no newsletters", () => {
    const labelOnly = getReadingSources({
      labelId: NEWSLETTER,
      cueMembership: NO_MEMBERSHIP,
    });
    const query = readingLaneQuery(labelOnly.lane);
    if (!query) throw new Error("expected a lane");
    expect(getMatchingScope(query, "google")).toEqual({
      labelIds: ["INBOX", NEWSLETTER],
    });
  });
});

describe("getReadingSources", () => {
  it("bundles an account Cue sorts without the label", () => {
    const sources = getReadingSources({
      labelId: undefined,
      cueMembership: MEMBERSHIP,
    });
    expect(inboxWithoutReadingQuery(sources.inbox)).not.toBeNull();
    expect(readingLaneQuery(sources.lane)).not.toBeNull();
  });

  it("has nothing to bundle when neither names a newsletter", () => {
    const sources = getReadingSources({
      labelId: undefined,
      cueMembership: NO_MEMBERSHIP,
    });
    expect(inboxWithoutReadingQuery(sources.inbox)).toBeNull();
    expect(readingLaneQuery(sources.lane)).toBeNull();
  });

  it("never holds the inbox for Cue's sorting, while the lane waits for it", () => {
    const sources = getReadingSources({
      labelId: undefined,
      cueMembership: undefined,
    });
    expect(inboxWithoutReadingQuery(sources.inbox)).toBeNull();
    expect(readingLaneQuery(sources.lane)).not.toBeNull();
  });
});

describe("getReadingSummary", () => {
  it("names who the newsletters are from, newest first, and counts the unread ones", () => {
    expect(
      getReadingSummary(
        [
          thread("Field Notes <hello@fieldnotes.example>", true),
          thread("Morning Brew <crew@morningbrew.example>", false),
          thread("Field Notes <hello@fieldnotes.example>", true),
        ],
        "me@example.com",
      ),
    ).toEqual({ senders: "Field Notes and Morning Brew", unreadCount: 2 });
  });
});

function predicateFor(
  query: ReturnType<typeof readingLaneQuery>,
  cueMembership: CueMembership,
) {
  if (!query) throw new Error("expected a query");
  return threadsQueryToPredicate(threadsQuery.parse(query), cueMembership);
}

function listMessage(id: string, labelIds: string[]) {
  return {
    id,
    labelIds,
    headers: { from: "news@example.com", to: "", subject: "", date: "" },
    internalDate: "1",
    inboxSection: undefined,
  };
}

function message(fields: Partial<EffectiveMessage>): EffectiveMessage {
  return {
    accountId: "acc-1",
    messageId: "m1",
    conversationId: "c1",
    subject: "Subject",
    preview: "Preview",
    from: "news@example.com",
    to: ["me@example.com"],
    cc: [],
    receivedAtMs: 1,
    read: false,
    starred: false,
    folderId: "inbox",
    inboxSection: null,
    labelIds: [],
    categoryIds: [],
    hasAttachments: false,
    pendingOperationIds: [],
    roles: [],
    ...fields,
  };
}

function thread(from: string, unread: boolean): ListThread {
  return {
    id: from,
    snippet: "",
    messages: [
      {
        id: `${from}-1`,
        threadId: from,
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        headers: { from, to: "me@example.com", subject: "", date: "" },
      },
    ],
  } as unknown as ListThread;
}
