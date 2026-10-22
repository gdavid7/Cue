import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { describe, expect, it } from "vitest";
import {
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  CUE_PROVIDER_SEARCH_QUEUE,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getAccountsWidenedPredicate,
  getAccountsWidenedSearches,
  getAccountWideningLadders,
  getCueRankingSearch,
  getFinishedProviderSearches,
  getNextAccountWidenings,
  getProviderSearchStarts,
  holdRowOrder,
  lastResortSearchId,
  scheduleAccountSearches,
  summarizeAccountWidenings,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import {
  rankCueFoundThreads,
  rankWithWidened,
} from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import type { SearchIntentParts } from "@/utils/mail-search/generated-search";

const NOW = new Date("2026-10-20T12:00:00Z");
const CONTEXT = { now: NOW, timeZone: "UTC" };
const PARTS: SearchIntentParts = {
  senders: ["sarah"],
  recipients: [],
  sentByUser: false,
  keywordGroups: [["lease"]],
  hasAttachment: true,
  unread: false,
  starred: false,
  label: "Receipts",
  dateRange: "none",
  lastNDays: 0,
  fromDate: "",
  toDate: "",
  explanation: "Lease from Sarah",
  isQuestion: false,
};
const GMAIL = {
  id: "gmail",
  provider: "google",
  labels: [{ id: "Label_1", name: "Receipts", accountId: "gmail" }],
};
const OUTLOOK = { id: "outlook", provider: "microsoft", labels: [] };

describe("getAccountCueSearches", () => {
  it("writes one reading as each account's own search", () => {
    const searches = getAccountCueSearches(PARTS, [GMAIL, OUTLOOK], CONTEXT);

    expect(searches).toEqual([
      {
        accountId: "gmail",
        search: "from:sarah lease has:attachment label:Receipts",
      },
      // Outlook's syntax, and no label the account doesn't have.
      { accountId: "outlook", search: "from:sarah lease hasattachments:true" },
    ]);
  });

  it("leaves out an account with nothing to search", () => {
    const labelOnly: SearchIntentParts = {
      ...PARTS,
      senders: [],
      keywordGroups: [],
      hasAttachment: false,
    };

    expect(getAccountCueSearches(labelOnly, [GMAIL, OUTLOOK], CONTEXT)).toEqual(
      [{ accountId: "gmail", search: "label:Receipts" }],
    );
  });
});

describe("getCueRankingSearch", () => {
  it("ranks every account by the same search, without a label", () => {
    expect(getCueRankingSearch(PARTS, CONTEXT)).toEqual([
      "from:sarah lease has:attachment",
    ]);
  });
});

describe("getAccountsCuePredicate", () => {
  const searches = getAccountCueSearches(PARTS, [GMAIL, OUTLOOK], CONTEXT);

  it("asks the provider only for the accounts whose turn it is", () => {
    const predicate = getAccountsCuePredicate({
      searches,
      accounts: [GMAIL, OUTLOOK],
      providerAccountIds: new Set(["gmail"]),
      unreadOnly: false,
      ...CONTEXT,
    });

    expect(providerSearchAccounts(predicate)).toEqual([["gmail"]]);
    // Outlook still reads its own local mail, and only its own.
    expect(JSON.stringify(predicate)).toContain(
      JSON.stringify({ kind: "account", ids: ["outlook"] }),
    );
  });

  it("keeps each account's search to that account", () => {
    const predicate = getAccountsCuePredicate({
      searches,
      accounts: [GMAIL, OUTLOOK],
      providerAccountIds: new Set(["gmail", "outlook"]),
      unreadOnly: false,
      ...CONTEXT,
    });

    expect(providerSearchAccounts(predicate)).toEqual([["gmail"], ["outlook"]]);
  });

  it("keeps only unread mail in every account, Outlook's included", () => {
    const unread = getAccountCueSearches(
      { ...PARTS, unread: true },
      [GMAIL, OUTLOOK],
      CONTEXT,
    );
    const predicate = getAccountsCuePredicate({
      searches: unread,
      accounts: [GMAIL, OUTLOOK],
      providerAccountIds: new Set(),
      unreadOnly: true,
      ...CONTEXT,
    });

    expect(predicate?.kind).toBe("any");
    const [gmail, outlook] =
      predicate?.kind === "any" ? predicate.predicates : [];
    const unreadOnly = JSON.stringify({ kind: "read", value: false });
    // Gmail's search says is:unread itself; Outlook's can't, so Cue adds it.
    expect(JSON.stringify(gmail)).toContain(unreadOnly);
    expect(JSON.stringify(outlook)).toContain(unreadOnly);
  });

  it("is empty when no account has a search", () => {
    expect(
      getAccountsCuePredicate({
        searches: [],
        accounts: [GMAIL],
        providerAccountIds: new Set(["gmail"]),
        unreadOnly: false,
        ...CONTEXT,
      }),
    ).toBeUndefined();
  });
});

describe("scheduleAccountSearches", () => {
  const ids = ["a", "b", "c", "d"];
  const none = new Set<string>();
  const schedule = (
    input: Partial<Parameters<typeof scheduleAccountSearches>[0]>,
  ) =>
    scheduleAccountSearches({
      accountIds: ids,
      queuedAtMs: {},
      finishedIds: none,
      timedOutIds: none,
      startedAtMs: {},
      nowMs: 0,
      ...input,
    });

  it("queues only as many provider searches as the queue holds", () => {
    const { phases, toQueue } = schedule({});

    expect(toQueue).toEqual(ids.slice(0, CUE_PROVIDER_SEARCH_QUEUE));
    expect(phases.c).toBe("waiting");
  });

  it("gives an answered account's turn to the next one", () => {
    const { phases, toQueue } = schedule({
      queuedAtMs: { a: 0, b: 0 },
      finishedIds: new Set(["a"]),
      queueSize: 2,
    });

    expect(phases).toMatchObject({ a: "finished", b: "searching" });
    expect(toQueue).toEqual(["c"]);
  });

  it("never counts the wait in the engine's queue against an account", () => {
    const { phases, toTimeOut, nextDeadlineMs } = schedule({
      queuedAtMs: { a: 0, b: 0 },
      // a began long ago; b is still waiting behind it.
      startedAtMs: { a: 1000 },
      nowMs: 1000 + CUE_ACCOUNT_SEARCH_TIMEOUT_MS - 1,
      queueSize: 2,
    });

    expect(phases).toMatchObject({ a: "searching", b: "searching" });
    expect(toTimeOut).toEqual([]);
    expect(nextDeadlineMs).toBe(1000 + CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
  });

  it("times out an account from when the engine began it, and moves on", () => {
    const { phases, toQueue, toTimeOut } = schedule({
      queuedAtMs: { a: 0, b: 0 },
      startedAtMs: { a: 0 },
      nowMs: CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
      queueSize: 2,
    });

    expect(phases).toMatchObject({ a: "timedOut", b: "searching" });
    expect(toTimeOut).toEqual(["a"]);
    expect(toQueue).toEqual(["c"]);
  });

  it("times out an account whose start never arrives, two boxes after queueing it", () => {
    const early = schedule({
      queuedAtMs: { a: 0 },
      nowMs: 2 * CUE_ACCOUNT_SEARCH_TIMEOUT_MS - 1,
      queueSize: 1,
    });
    expect(early.phases.a).toBe("searching");
    expect(early.nextDeadlineMs).toBe(2 * CUE_ACCOUNT_SEARCH_TIMEOUT_MS);

    const late = schedule({
      queuedAtMs: { a: 0 },
      nowMs: 2 * CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
      queueSize: 1,
    });
    expect(late.toTimeOut).toEqual(["a"]);
    expect(late.toQueue).toEqual(["b"]);
  });

  it("queues an account's last resort behind the first searches, in the same queue", () => {
    const { phases, toQueue } = schedule({
      accountIds: ["a", "b", lastResortSearchId("a")],
      queuedAtMs: { b: 0 },
      finishedIds: new Set(["a"]),
    });

    // One turn is free: "b" holds the other, so the last resort takes it.
    expect(toQueue).toEqual([lastResortSearchId("a")]);
    expect(phases[lastResortSearchId("a")]).toBe("searching");
    expect(
      schedule({
        accountIds: ["a", "b", "c", lastResortSearchId("a")],
        queuedAtMs: { b: 0, c: 0 },
        finishedIds: new Set(["a"]),
      }).phases[lastResortSearchId("a")],
    ).toBe("waiting");
  });

  it("takes an account's first search's time off its last resort's box", () => {
    const id = lastResortSearchId("a");
    const input = {
      accountIds: [id],
      queuedAtMs: { [id]: 0 },
      startedAtMs: { [id]: 1000 },
      spentMs: { [id]: 3000 },
    };

    expect(
      schedule({ ...input, nowMs: 1000 + CUE_ACCOUNT_SEARCH_TIMEOUT_MS - 3001 })
        .phases[id],
    ).toBe("searching");
    expect(
      schedule({ ...input, nowMs: 1000 + CUE_ACCOUNT_SEARCH_TIMEOUT_MS - 3000 })
        .toTimeOut,
    ).toEqual([id]);
  });

  it("keeps a timed-out account out of the queue", () => {
    const { phases, toQueue, nextDeadlineMs } = schedule({
      accountIds: ["a", "b"],
      queuedAtMs: { a: 0, b: 0 },
      finishedIds: new Set(["b"]),
      timedOutIds: new Set(["a"]),
    });

    expect(phases).toEqual({ a: "timedOut", b: "finished" });
    expect(toQueue).toEqual([]);
    expect(nextDeadlineMs).toBeNull();
  });
});

describe("getProviderSearchStarts", () => {
  it("reads when the engine began each running search", () => {
    expect(
      getProviderSearchStarts([
        {
          accountId: "a",
          state: "searching",
          answered: false,
          startedAtMs: 5,
        },
        { accountId: "b", state: "searching", answered: false },
        // Held back by quota, still timed from its start.
        { accountId: "c", state: "busy", answered: false, startedAtMs: 7 },
      ]),
    ).toEqual({ a: 5, c: 7 });
  });
});

describe("cross-account ranking", () => {
  it("demotes Cue's own newsletter label only in the account that has it", () => {
    // Gmail numbers labels per account, so the same id means different
    // labels in different accounts.
    const thread = (accountId: string): ListThread =>
      ({
        id: `${accountId}-1`,
        snippet: "",
        account: {
          id: accountId,
          email: `${accountId}@example.com`,
          name: null,
          image: null,
          provider: "google",
        },
        messages: [
          {
            id: `${accountId}-m`,
            threadId: `${accountId}-1`,
            labelIds: ["Label_3"],
            internalDate: String(NOW.getTime() - (accountId === "b" ? 1 : 0)),
            headers: { subject: "Lease", from: "", to: "", date: "" },
          },
        ],
      }) as unknown as ListThread;
    const ranked = rankCueFoundThreads([thread("a"), thread("b")], {
      searches: ["lease"],
      labels: [
        { id: "Label_3", name: "Newsletter", accountId: "a" },
        { id: "Label_3", name: "Clients", accountId: "b" },
      ],
      now: NOW,
      timeZone: "UTC",
      provider: "google",
    });

    expect(ranked.map((row) => row.id)).toEqual(["b-1", "a-1"]);
  });

  it("keeps each account's labels apart when a wider tier's mail joins in", () => {
    const thread = (accountId: string, subject: string): ListThread =>
      ({
        id: `${accountId}-1`,
        snippet: "",
        account: {
          id: accountId,
          email: `${accountId}@example.com`,
          name: null,
          image: null,
          provider: "google",
        },
        messages: [
          {
            id: `${accountId}-m`,
            threadId: `${accountId}-1`,
            labelIds: ["Label_3"],
            internalDate: String(NOW.getTime()),
            headers: { subject, from: "sarah", to: "", date: "" },
          },
        ],
      }) as unknown as ListThread;
    const context = {
      searches: ["lease"],
      labels: [
        { id: "Label_3", name: "Newsletter", accountId: "a" },
        { id: "Label_3", name: "Clients", accountId: "b" },
      ],
      now: NOW,
      timeZone: "UTC",
      provider: "google" as const,
    };
    // "a" found a newsletter, so it competes with what "b" widened to;
    // "b"'s same label id is no newsletter, so its match isn't demoted.
    const ranked = rankWithWidened(
      [thread("a", "Lease")],
      [thread("b", "Lease")],
      context,
    );

    expect(ranked.map((row) => row.id)).toEqual(["b-1", "a-1"]);
  });
});

describe("account widening", () => {
  const searches = [
    { accountId: "gmail", search: "from:sarah lease" },
    { accountId: "outlook", search: "from:sarah lease" },
  ];
  const ladders = getAccountWideningLadders(
    searches,
    [GMAIL, OUTLOOK],
    CONTEXT,
  );
  const settled = (count: number) => ({ settled: true, count });

  it("builds a ladder only for the accounts searched", () => {
    expect(Object.keys(ladders)).toEqual(["gmail", "outlook"]);
    expect(ladders.gmail?.[0]?.searches).toEqual(["from:sarah"]);
    // An account left out of All inboxes gets no ladder, so no wider search.
    expect(
      Object.keys(getAccountWideningLadders(searches, [GMAIL], CONTEXT)),
    ).toEqual(["gmail"]);
  });

  it("widens only the account that found too little", () => {
    const next = getNextAccountWidenings({
      ladders,
      widenings: {},
      primary: { gmail: settled(5), outlook: settled(1) },
      widened: {},
      expired: false,
      providerAllowedIds: new Set(["gmail", "outlook"]),
    });

    expect(next).toEqual({ outlook: { step: 0, onProvider: false } });
    expect(getAccountsWidenedSearches(ladders, next ?? {})).toEqual([
      { accountId: "outlook", search: "from:sarah" },
    ]);
  });

  it("waits on an account whose search hasn't answered", () => {
    expect(
      getNextAccountWidenings({
        ladders,
        widenings: {},
        primary: { gmail: { settled: false, count: 0 }, outlook: settled(3) },
        widened: {},
        expired: false,
        providerAllowedIds: new Set(),
      }),
    ).toBeNull();
  });

  it("asks an account's provider last only when it found nothing and has time left", () => {
    const input = {
      ladders,
      widenings: {
        gmail: { step: 0, onProvider: false },
        outlook: { step: 0, onProvider: false },
      },
      primary: { gmail: settled(0), outlook: settled(0) },
      widened: { gmail: settled(0), outlook: settled(0) },
      expired: false,
    };

    // Outlook's first provider search ran out its box, so it isn't asked again.
    expect(
      getNextAccountWidenings({
        ...input,
        providerAllowedIds: new Set(["gmail"]),
      }),
    ).toEqual({ gmail: { step: 0, onProvider: true } });
    expect(
      getNextAccountWidenings({
        ...input,
        expired: true,
        providerAllowedIds: new Set(["gmail"]),
      }),
    ).toBeNull();
  });

  it("sends one search of a last resort to the provider, the rest local", () => {
    const predicate = getAccountsWidenedPredicate({
      searches: [
        { accountId: "gmail", search: "from:sarah lease" },
        { accountId: "gmail", search: "from:sarah contract" },
        { accountId: "outlook", search: "from:sarah" },
      ],
      accounts: [GMAIL, OUTLOOK],
      lastResortIds: new Set(["gmail"]),
      ...CONTEXT,
    });

    // One provider search answers or times out as one; Outlook isn't on
    // its last resort, so it reads its local mail alone.
    expect(providerSearchAccounts(predicate)).toEqual([["gmail"]]);
    expect(JSON.stringify(predicate)).toContain("contract");
  });

  it("says which tier Cue widened to across accounts", () => {
    expect(
      summarizeAccountWidenings(ladders, {
        outlook: { step: 0, onProvider: true },
      }),
    ).toEqual({
      tier: "fewer_words",
      searches: ["from:sarah"],
      onProvider: true,
    });
    expect(summarizeAccountWidenings(ladders, {})).toBeNull();
  });
});

describe("getFinishedProviderSearches", () => {
  it("counts answered and unreachable providers, and waits on busy ones", () => {
    expect(
      getFinishedProviderSearches([
        { accountId: "answered", state: "complete", answered: true },
        { accountId: "partly", state: "searching", answered: true },
        { accountId: "running", state: "searching", answered: false },
        { accountId: "busy", state: "busy", answered: false },
        { accountId: "offline", state: "unavailable", answered: false },
        { accountId: "reconnect", state: "reconnect", answered: false },
      ]),
    ).toEqual(["answered", "partly", "offline", "reconnect"]);
  });
});

describe("holdRowOrder", () => {
  const row = (accountId: string, id: string) => ({
    id,
    account: { id: accountId },
  });

  it("keeps the rows on screen in place and adds each later batch below", () => {
    const first = holdRowOrder(
      [row("b", "late"), row("a", "2"), row("a", "1")],
      ["a:1", "a:2"],
    );
    expect(first.threads).toEqual([
      row("a", "1"),
      row("a", "2"),
      row("b", "late"),
    ]);

    // A later, better-ranked batch still lands below what is shown.
    const second = holdRowOrder(
      [row("c", "best"), row("b", "late"), row("a", "2"), row("a", "1")],
      first.order,
    );
    expect(second.threads.map((thread) => thread.id)).toEqual([
      "1",
      "2",
      "late",
      "best",
    ]);
  });

  it("keeps the same order when nothing new arrives", () => {
    const order = ["a:1"];
    expect(holdRowOrder([row("a", "1")], order).order).toBe(order);
  });
});

function providerSearchAccounts(
  predicate: MailPredicate | undefined,
): (string[] | undefined)[] {
  if (!predicate) return [];
  switch (predicate.kind) {
    case "search":
      return [predicate.accountIds];
    case "all":
    case "any":
      return predicate.predicates.flatMap(providerSearchAccounts);
    case "not":
      return providerSearchAccounts(predicate.predicate);
    default:
      return [];
  }
}
