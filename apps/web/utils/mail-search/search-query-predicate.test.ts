import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageMetadata } from "@inboxzero/mail-core/messages";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import {
  buildMailSearchQuery,
  EMPTY_MAIL_SEARCH_FIELDS,
  type MailSearchFields,
} from "@/app/(app)/[emailAccountId]/mail/mail-search-query";
import {
  buildOutlookSearchQuery,
  EMPTY_OUTLOOK_SEARCH_FIELDS,
  type OutlookSearchFields,
} from "@/app/(app)/[emailAccountId]/mail/outlook-search-query";
import { resolveSearchPredicates } from "@inboxzero/mail-core/query-semantics";
import {
  searchQueryForAccounts,
  searchQueryToPredicate,
  searchReachesSpamOrTrash,
} from "@/utils/mail-search/search-query-predicate";

const ACCOUNT = "account-1";
const NOW = new Date("2024-03-10T12:00:00Z");
const LABELS = [
  { id: "Label_work", name: "Work" },
  { id: "Label_trips", name: "Travel/Trips" },
];

const MESSAGES: Array<{ id: string } & Partial<MessageMetadata>> = [
  {
    id: "amy",
    from: "Amy Pond <amy@example.com>",
    to: ["me@example.com"],
    cc: ["rory@example.com"],
    bcc: ["doctor@example.com"],
    subject: "Dinner plans",
    preview: "Movie at eight",
    receivedAtMs: Date.parse("2024-01-15T12:00:00Z"),
    read: false,
    roles: ["inbox"],
    hasAttachments: true,
    labelIds: ["Label_work"],
    categoryIds: ["CATEGORY_SOCIAL"],
  },
  {
    id: "bob",
    from: "bob@corp.com",
    subject: "Quarterly invoice",
    preview: "Please pay",
    receivedAtMs: Date.parse("2024-03-01T12:00:00Z"),
    starred: true,
    roles: [],
    labelIds: ["IMPORTANT", "Label_trips"],
    categoryIds: ["CATEGORY_UPDATES"],
  },
  {
    id: "sent",
    from: "me@example.com",
    to: ["amy@example.com"],
    subject: "Re: Dinner plans",
    preview: "Sounds good",
    receivedAtMs: Date.parse("2024-01-16T12:00:00Z"),
    roles: ["sent"],
  },
  {
    id: "draft",
    from: "me@example.com",
    subject: "Draft note",
    preview: "Unfinished",
    receivedAtMs: Date.parse("2024-03-05T12:00:00Z"),
    roles: ["draft"],
  },
  {
    id: "spam",
    from: "winner@lottery.biz",
    subject: "You won",
    preview: "Claim your dinner prize",
    receivedAtMs: Date.parse("2024-02-20T12:00:00Z"),
    roles: ["spam"],
  },
  {
    id: "trash",
    from: "amy@example.com",
    subject: "Old dinner",
    preview: "Deleted",
    receivedAtMs: Date.parse("2024-01-10T12:00:00Z"),
    roles: ["trash"],
  },
];

let store: Awaited<ReturnType<typeof createSqliteMailStore>>;

beforeAll(async () => {
  store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: ACCOUNT,
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: ACCOUNT, generation: "g1" },
      requestId: "seed",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: MESSAGES.map(messagePatch),
      requiredHydration: [],
      roundComplete: true,
    },
  });
});

afterAll(async () => {
  await store.close();
});

describe("searchQueryToPredicate, read by the local store", () => {
  it.each<[string, string[]]>([
    // Free text and phrases; spam and trash stay out, as in Gmail.
    ["dinner", ["amy", "sent"]],
    ['"dinner plans"', ["amy", "sent"]],
    ["dinner plans", ["amy", "sent"]],
    // Senders and recipients.
    ["from:amy@example.com", ["amy"]],
    ["from:amy", ["amy"]],
    ["from:corp.com", ["bob"]],
    ["to:amy@example.com", ["sent"]],
    ["to:rory@example.com", ["amy"]],
    ["cc:rory", ["amy"]],
    ["bcc:doctor@example.com", ["amy"]],
    ["subject:invoice", ["bob"]],
    ['subject:"dinner plans"', ["amy", "sent"]],
    // Attachments.
    ["has:attachment", ["amy"]],
    ["hasattachments:true", ["amy"]],
    // State.
    ["is:unread", ["amy"]],
    ["is:starred", ["bob"]],
    ["is:flagged", ["bob"]],
    ["is:important", ["bob"]],
    // Mailboxes.
    ["in:inbox", ["amy"]],
    ["in:sent", ["sent"]],
    ["in:drafts", ["draft"]],
    ["in:spam", ["spam"]],
    ["in:trash", ["trash"]],
    ["in:anywhere dinner", ["amy", "sent", "spam", "trash"]],
    ["dinner -in:chats", ["amy", "sent"]],
    // Labels by name, as the advanced search form writes them.
    ["label:Work", ["amy"]],
    ["label:work", ["amy"]],
    ["label:travel-trips", ["bob"]],
    ["label:Label_work", ["amy"]],
    ["label:important", ["bob"]],
    ["category:social", ["amy"]],
    ["category:updates", ["bob"]],
    // Dates, at midnight Pacific time like the Gmail API.
    ["after:2024/02/01", ["bob", "draft"]],
    ["before:2024/01/16", ["amy"]],
    ["after:2024-01-15 before:2024-01-17", ["amy", "sent"]],
    ["after:1/15/2024 before:1/17/2024", ["amy", "sent"]],
    ["newer_than:7d", ["draft"]],
    ["older_than:1m", ["amy", "sent"]],
    ["received>=2024-03-01", ["bob", "draft"]],
    // Boolean structure.
    ["dinner OR invoice", ["amy", "sent", "bob"]],
    ["{dinner invoice}", ["amy", "sent", "bob"]],
    ["dinner -from:me@example.com", ["amy"]],
    ["-in:inbox dinner", ["sent"]],
    ["NOT in:inbox dinner", ["sent"]],
    ["(dinner OR invoice) is:unread", ["amy"]],
    ["from:(amy OR bob)", ["amy", "bob"]],
    ["subject:(dinner plans)", ["amy", "sent"]],
  ])("%s", async (query, expected) => {
    expect(await localMatches(query)).toEqual(expected.sort());
  });

  it.each([
    "larger:5M",
    "smaller:10K",
    "filename:pdf",
    "has:drive",
    "list:info@example.com",
    "from:me",
    "label:Unknown",
    "dinner AROUND 3 movie",
    // A negated condition the store can't evaluate leaves nothing it can
    // vouch for.
    "dinner -larger:5M",
  ])("leaves %s to the provider instead of guessing", async (query) => {
    expect(await localMatches(query)).toEqual([]);
  });

  it("still answers the parts it can of an alternative it can't", async () => {
    expect(await localMatches("dinner OR larger:5M")).toEqual(["amy", "sent"]);
  });

  it("hands the provider the query exactly as typed", () => {
    const query = "from:amy  {dinner movie} -larger:5M";
    expect(
      searchQueryToPredicate(query, { now: NOW, labels: LABELS }),
    ).toMatchObject({
      kind: "all",
      predicates: [
        { kind: "search", query: query.trim() },
        { kind: "mailbox" },
      ],
    });
  });

  it("has nothing to search for in an empty query", () => {
    expect(searchQueryToPredicate("  ", { now: NOW })).toBeNull();
  });
});

// Every field of the advanced search forms writes a query the store reads as
// that field means, rather than as literal words.
describe("advanced search form queries", () => {
  it.each<[string, Partial<MailSearchFields>, string[]]>([
    ["from", { from: "amy@example.com" }, ["amy"]],
    ["to", { to: "amy@example.com" }, ["sent"]],
    ["subject", { subject: "Quarterly invoice" }, ["bob"]],
    ["has the words", { hasWords: "dinner" }, ["amy", "sent"]],
    ["doesn't have", { hasWords: "dinner", doesntHave: "movie" }, ["sent"]],
    ["has attachment", { hasAttachment: true }, ["amy"]],
    ["date within", { date: "2024-01-15", dateWithin: "1d" }, ["amy"]],
    ["search in Inbox", { searchIn: "inbox" }, ["amy"]],
    ["search in Starred", { searchIn: "starred" }, ["bob"]],
    ["search in Sent", { searchIn: "sent" }, ["sent"]],
    ["search in Drafts", { searchIn: "drafts" }, ["draft"]],
    ["search in Spam", { searchIn: "spam" }, ["spam"]],
    ["search in Trash", { searchIn: "trash" }, ["trash"]],
    [
      "search in Mail & Spam & Trash",
      { searchIn: "anywhere", hasWords: "dinner" },
      ["amy", "sent", "spam", "trash"],
    ],
    ["search in a label", { searchIn: "label:Work" }, ["amy"]],
    [
      "don't include chats",
      { hasWords: "dinner", excludeChats: true },
      ["amy", "sent"],
    ],
    // Sizes aren't stored locally; Gmail answers them.
    ["size", { sizeValue: "5", sizeComparison: "greater" }, []],
  ])("Gmail: %s", async (_field, fields, expected) => {
    const query = buildMailSearchQuery({
      ...EMPTY_MAIL_SEARCH_FIELDS,
      ...fields,
    });
    expect(await localMatches(query, "google")).toEqual(expected.sort());
  });

  it("writes the size Gmail reads", () => {
    expect(
      buildMailSearchQuery({
        ...EMPTY_MAIL_SEARCH_FIELDS,
        sizeValue: "5",
        sizeComparison: "greater",
      }),
    ).toBe("larger:5M");
  });

  it.each<[string, Partial<OutlookSearchFields>, string[]]>([
    ["from", { from: "amy@example.com" }, ["amy"]],
    ["to", { to: "amy@example.com" }, ["sent"]],
    ["subject", { subject: "Quarterly invoice" }, ["bob"]],
    ["keywords", { keywords: "dinner" }, ["amy", "sent"]],
    ["doesn't have", { keywords: "dinner", doesntHave: "movie" }, ["sent"]],
    ["has attachment", { hasAttachment: true }, ["amy"]],
    ["date within", { date: "2024-01-15", dateWithin: "1d" }, ["amy"]],
    ["search in Inbox", { searchIn: "inbox" }, ["amy"]],
    ["search in Flagged", { searchIn: "flagged" }, ["bob"]],
    ["search in Sent", { searchIn: "sent" }, ["sent"]],
    ["search in Drafts", { searchIn: "drafts" }, ["draft"]],
    // Like Cue's Archive view: mail out of the inbox, spam and trash.
    ["search in Archive", { searchIn: "archive" }, ["bob", "draft", "sent"]],
    ["search in Junk", { searchIn: "junk" }, ["spam"]],
    ["search in Deleted", { searchIn: "deleted" }, ["trash"]],
    ["search in a category", { searchIn: "category:Work" }, ["amy"]],
  ])("Outlook: %s", async (_field, fields, expected) => {
    const query = buildOutlookSearchQuery({
      ...EMPTY_OUTLOOK_SEARCH_FIELDS,
      ...fields,
    });
    expect(await localMatches(query, "microsoft")).toEqual(expected.sort());
  });
});

describe("the provider's matches", () => {
  it("shows what only the provider could match", async () => {
    expect(await localMatches("larger:5M", "google", ["bob"])).toEqual(["bob"]);
  });

  it.each<[string, string[], string[]]>([
    // Archived since Gmail matched it.
    ["in:inbox larger:5M", ["amy", "bob"], ["amy"]],
    // Read since Gmail matched it.
    ["is:unread larger:5M", ["amy", "bob"], ["amy"]],
    ["larger:5M -is:starred", ["amy", "bob"], ["amy"]],
  ])("drops a match %s no longer allows", async (query, matched, expected) => {
    expect(await localMatches(query, "google", matched)).toEqual(expected);
  });

  it("keeps a match on words the store can't judge", async () => {
    // Gmail may have matched the word in a body or attachment the store
    // doesn't hold.
    expect(await localMatches("ledger larger:5M", "google", ["amy"])).toEqual([
      "amy",
    ]);
  });

  it.each([
    // Gmail counts attachments the store may not, and has its own snooze.
    "has:attachment larger:5M",
    "is:snoozed larger:5M",
  ])("keeps a match on %s, which the store can't judge either", async (query) => {
    expect(await localMatches(query, "google", ["bob"])).toEqual(["bob"]);
  });

  it("still leaves spam and trash out", async () => {
    expect(await localMatches("larger:5M", "google", ["spam"])).toEqual([]);
  });
});

describe("searchReachesSpamOrTrash", () => {
  it.each<[string, "google" | "microsoft" | undefined, boolean]>([
    ["in:trash", "google", true],
    ["in:spam invoice", "google", true],
    ["label:spam", "google", true],
    ["in:anywhere", "google", true],
    ["invoice OR in:trash", "google", true],
    ["IN:TRASH", "google", true],
    ["-in:trash", "google", false],
    ["NOT in:spam", "google", false],
    ['"in:trash"', "google", false],
    ["in:junk", "google", false],
    ["invoice", "google", false],
    ["in:junk", "microsoft", true],
    ["in:deleted", "microsoft", true],
    // Graph has no in:anywhere.
    ["in:anywhere", "microsoft", false],
    ["in:trash", undefined, true],
  ])("%s (%s) → %s", (query, provider, expected) => {
    expect(searchReachesSpamOrTrash(query, provider)).toBe(expected);
  });

  it("keeps Gmail's default scope for Outlook's in:anywhere", async () => {
    expect(await localMatches("in:anywhere dinner", "microsoft")).toEqual([
      "amy",
      "sent",
    ]);
  });
});

describe("searching across a Gmail and an Outlook account", () => {
  const ACCOUNTS = [
    { id: "gmail", provider: "google" },
    { id: "outlook", provider: "microsoft" },
  ];
  let mixed: Awaited<ReturnType<typeof createSqliteMailStore>>;

  beforeAll(async () => {
    mixed = await createSqliteMailStore(createNodeSqliteDriver());
    for (const account of ACCOUNTS) {
      await mixed.ensureAccount({
        accountId: account.id,
        provider: account.provider as "google" | "microsoft",
        generation: "g1",
      });
      const message = (
        id: string,
        fields: Partial<MessageMetadata>,
      ): Extract<ProviderChange, { kind: "message_patch" }> => ({
        ...messagePatch({ id, ...fields }),
        key: { accountId: account.id, messageId: id },
      });
      await mixed.applySyncPage({
        ownerId: "owner",
        page: {
          session: { accountId: account.id, generation: "g1" },
          requestId: "seed",
          from: { streamId: "primary", generation: "g1", checkpoint: null },
          to: { streamId: "primary", generation: "g1", checkpoint: "1" },
          changes: [
            message(`${account.id}-inbox`, {
              subject: "Dinner menu",
              roles: ["inbox"],
              hasAttachments: true,
              receivedAtMs: 2,
            }),
            message(`${account.id}-junk`, {
              subject: "Dinner prize",
              roles: ["spam"],
              receivedAtMs: 1,
            }),
          ],
          requiredHydration: [],
          roundComplete: true,
        },
      });
    }
  });

  afterAll(async () => {
    await mixed.close();
  });

  async function mixedMatches(query: string) {
    const predicate = searchQueryForAccounts(query, { now: NOW }, ACCOUNTS);
    if (!predicate) throw new Error("No predicate");
    const { view } = await mixed.readMailboxView({
      accountIds: ACCOUNTS.map((account) => account.id),
      predicate,
      order: "newest_first",
      pageSize: 50,
      after: null,
    });
    return view.conversations.map((row) => row.key.conversationId).sort();
  }

  it.each<[string, string[]]>([
    ["dinner", ["gmail-inbox", "outlook-inbox"]],
    ["has:attachment", ["gmail-inbox", "outlook-inbox"]],
    // Outlook's KQL filters Outlook mail; to Gmail it is just words.
    ["hasattachments:true", ["outlook-inbox"]],
    // Each provider's spam tokens reach only its own spam.
    ["in:junk dinner", ["outlook-junk"]],
    ["in:spam dinner", ["gmail-junk", "outlook-junk"]],
    ["in:anywhere dinner", ["gmail-inbox", "gmail-junk", "outlook-inbox"]],
  ])("%s", async (query, expected) => {
    expect(await mixedMatches(query)).toEqual(expected);
  });

  it("reads one provider's accounts as one search", () => {
    expect(
      searchQueryForAccounts("dinner", { now: NOW }, [
        { id: "a", provider: "google" },
        { id: "b", provider: "google" },
      ]),
    ).toEqual(
      searchQueryToPredicate("dinner", { now: NOW, provider: "google" }),
    );
  });
});

describe("label:Name across accounts", () => {
  // Each account names its labels with its own ids; one id even means a
  // different label in another account.
  const ACCOUNTS = [
    {
      id: "gmail-a",
      provider: "google",
      labels: [
        { id: "Label_1", name: "Work" },
        { id: "Label_2", name: "Parent/Child" },
      ],
    },
    {
      id: "gmail-b",
      provider: "google",
      labels: [
        { id: "Label_9", name: "work" },
        { id: "Label_1", name: "Personal" },
      ],
    },
    {
      id: "outlook",
      provider: "microsoft",
      labels: [{ id: "category-work", name: "WORK" }],
    },
  ];
  const MAIL: Record<string, Array<[string, string[]]>> = {
    "gmail-a": [
      ["a-work", ["Label_1"]],
      ["a-nested", ["Label_2"]],
      ["a-plain", []],
    ],
    "gmail-b": [
      ["b-work", ["Label_9"]],
      ["b-personal", ["Label_1"]],
    ],
    outlook: [
      ["o-work", ["category-work"]],
      ["o-plain", []],
    ],
  };
  let labelled: Awaited<ReturnType<typeof createSqliteMailStore>>;

  beforeAll(async () => {
    labelled = await createSqliteMailStore(createNodeSqliteDriver());
    for (const account of ACCOUNTS) {
      await labelled.ensureAccount({
        accountId: account.id,
        provider: account.provider as "google" | "microsoft",
        generation: "g1",
      });
      await labelled.applySyncPage({
        ownerId: "owner",
        page: {
          session: { accountId: account.id, generation: "g1" },
          requestId: "seed",
          from: { streamId: "primary", generation: "g1", checkpoint: null },
          to: { streamId: "primary", generation: "g1", checkpoint: "1" },
          changes: MAIL[account.id].map(([id, labelIds]) => ({
            ...messagePatch({ id, labelIds, roles: ["inbox"] }),
            key: { accountId: account.id, messageId: id },
          })),
          requiredHydration: [],
          roundComplete: true,
        },
      });
    }
  });

  afterAll(async () => {
    await labelled.close();
  });

  async function labelledMatches(
    query: string,
    accounts: Array<{
      id: string;
      provider: string;
      labels?: Array<{ id: string; name: string }>;
    }> = ACCOUNTS,
  ) {
    const predicate = searchQueryForAccounts(query, { now: NOW }, accounts);
    if (!predicate) throw new Error("No predicate");
    const { view } = await labelled.readMailboxView({
      accountIds: accounts.map((account) => account.id),
      predicate: resolveSearchPredicates(predicate, () => []),
      order: "newest_first",
      pageSize: 50,
      after: null,
    });
    return view.conversations.map((row) => row.key.conversationId).sort();
  }

  it.each<[string, string[]]>([
    // Matched by name in every account, whatever its case or provider.
    ["label:Work", ["a-work", "b-work", "o-work"]],
    ["label:work", ["a-work", "b-work", "o-work"]],
    // A label only one account has.
    ["label:Personal", ["b-personal"]],
    ["label:Parent/Child", ["a-nested"]],
    ["label:parent-child", ["a-nested"]],
    ["-label:Work", ["a-nested", "a-plain", "b-personal", "o-plain"]],
  ])("%s", async (query, expected) => {
    expect(await labelledMatches(query)).toEqual(expected);
  });

  it("reads one provider's accounts by each account's own labels", async () => {
    expect(await labelledMatches("label:Work", ACCOUNTS.slice(0, 2))).toEqual([
      "a-work",
      "b-work",
    ]);
  });

  it("doesn't read a raw label id across accounts, where it means a different label in each", async () => {
    expect(await labelledMatches("label:Label_1")).toEqual([]);
  });

  it("still matches the other accounts by name when one account's labels failed to load", async () => {
    // A failed fetch reads as an account with no labels.
    const failed = ACCOUNTS.map((account) =>
      account.id === "gmail-b" ? { ...account, labels: [] } : account,
    );
    expect(await labelledMatches("label:Work", failed)).toEqual([
      "a-work",
      "o-work",
    ]);
  });

  it("leaves a provider group's labels to its providers while any of its accounts' labels are unknown", async () => {
    const partial = ACCOUNTS.map((account) =>
      account.id === "gmail-b"
        ? { id: account.id, provider: account.provider }
        : account,
    );
    // The Outlook group has its labels; the Gmail group waits on gmail-b.
    expect(await labelledMatches("label:Work", partial)).toEqual(["o-work"]);
  });

  it("leaves a label to the providers while labels load", async () => {
    const loading = ACCOUNTS.map(({ id, provider }) => ({ id, provider }));
    expect(await labelledMatches("label:Work", loading)).toEqual([]);
  });
});

describe("syntax per provider", () => {
  it("reads Outlook's KQL as words for a Gmail account, as Gmail does", async () => {
    expect(await localMatches("hasattachments:true", "google")).toEqual([]);
    expect(await localMatches("received>=2024-03-01", "google")).toEqual([]);
    expect(await localMatches("hasattachments:true", "microsoft")).toEqual([
      "amy",
    ]);
  });

  it("matches LIKE wildcards in an address as themselves", async () => {
    expect(await localMatches("from:_")).toEqual([]);
    expect(await localMatches("from:%")).toEqual([]);
  });
});

async function localMatches(
  query: string,
  provider?: "google" | "microsoft",
  providerMatched: string[] = [],
) {
  const predicate = searchQueryToPredicate(query, {
    now: NOW,
    labels: LABELS,
    timeZone: "UTC",
    provider,
  });
  if (!predicate) throw new Error("No predicate");
  const { view } = await store.readMailboxView({
    accountIds: [ACCOUNT],
    predicate: resolveSearchPredicates(predicate, () => [
      { accountId: ACCOUNT, messageIds: providerMatched },
    ]),
    order: "newest_first",
    pageSize: 50,
    after: null,
  });
  return view.conversations.map((row) => row.key.conversationId).sort();
}

function messagePatch(
  message: (typeof MESSAGES)[number],
): Extract<ProviderChange, { kind: "message_patch" }> {
  const { id, ...fields } = message;
  return {
    kind: "message_patch",
    key: { accountId: ACCOUNT, messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: id,
      version: "1",
    },
    fields: {
      subject: "",
      preview: "",
      from: "someone@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      receivedAtMs: 0,
      read: true,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      roles: [],
      hasAttachments: false,
      ...fields,
    },
  };
}
