import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { describe, expect, it } from "vitest";
import {
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  CUE_PROVIDER_SEARCH_QUEUE,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getCueRankingSearch,
  getFinishedProviderSearches,
  getProviderSearchStarts,
  holdRowOrder,
  scheduleAccountSearches,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import { rankCueFoundThreads } from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
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
      queuedIds: none,
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
      queuedIds: new Set(["a", "b"]),
      finishedIds: new Set(["a"]),
      queueSize: 2,
    });

    expect(phases).toMatchObject({ a: "finished", b: "searching" });
    expect(toQueue).toEqual(["c"]);
  });

  it("never counts the wait in the engine's queue against an account", () => {
    const { phases, toTimeOut, nextDeadlineMs } = schedule({
      queuedIds: new Set(["a", "b"]),
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
      queuedIds: new Set(["a", "b"]),
      startedAtMs: { a: 0 },
      nowMs: CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
      queueSize: 2,
    });

    expect(phases).toMatchObject({ a: "timedOut", b: "searching" });
    expect(toTimeOut).toEqual(["a"]);
    expect(toQueue).toEqual(["c"]);
  });

  it("keeps a timed-out account out of the queue", () => {
    const { phases, toQueue, nextDeadlineMs } = schedule({
      accountIds: ["a", "b"],
      queuedIds: new Set(["a", "b"]),
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
      ]),
    ).toEqual({ a: 5 });
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
