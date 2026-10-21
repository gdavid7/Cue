import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { describe, expect, it } from "vitest";
import {
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  CUE_PROVIDER_SEARCH_CONCURRENCY,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getCueRankingSearch,
  getFinishedProviderSearches,
  keepFrozenRowsFirst,
  scheduleAccountSearches,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
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

  it("starts only as many provider searches as the cap allows", () => {
    const { phases, toStart } = scheduleAccountSearches({
      accountIds: ids,
      startedAtMs: {},
      finishedIds: new Set(),
      nowMs: 0,
    });

    expect(toStart).toEqual(ids.slice(0, CUE_PROVIDER_SEARCH_CONCURRENCY));
    expect(phases.c).toBe("waiting");
  });

  it("gives an answered account's turn to the next one", () => {
    const { phases, toStart } = scheduleAccountSearches({
      accountIds: ids,
      startedAtMs: { a: 0, b: 0 },
      finishedIds: new Set(["a"]),
      nowMs: 1000,
      concurrency: 2,
    });

    expect(phases).toMatchObject({ a: "finished", b: "searching" });
    expect(toStart).toEqual(["c"]);
  });

  it("times out a slow account and moves on without it", () => {
    const { phases, toStart, nextDeadlineMs } = scheduleAccountSearches({
      accountIds: ids,
      startedAtMs: { a: 0, b: 1000 },
      finishedIds: new Set(),
      nowMs: CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
      concurrency: 2,
    });

    expect(phases).toMatchObject({ a: "timedOut", b: "searching" });
    expect(toStart).toEqual(["c"]);
    // The next look is when b's time box ends.
    expect(nextDeadlineMs).toBe(1000 + CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
  });

  it("has nothing to wait for once every account is done", () => {
    const { toStart, nextDeadlineMs } = scheduleAccountSearches({
      accountIds: ["a", "b"],
      startedAtMs: { a: 0, b: 0 },
      finishedIds: new Set(["a"]),
      nowMs: CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
    });

    expect(toStart).toEqual([]);
    expect(nextDeadlineMs).toBeNull();
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

describe("keepFrozenRowsFirst", () => {
  const row = (accountId: string, id: string) => ({
    id,
    account: { id: accountId },
  });

  it("keeps the rows on screen in place and adds late ones below", () => {
    const live = [row("b", "late"), row("a", "1"), row("a", "2")];

    expect(keepFrozenRowsFirst(live, ["a:1", "a:2"])).toEqual([
      row("a", "1"),
      row("a", "2"),
      row("b", "late"),
    ]);
  });

  it("changes nothing before the budget is spent", () => {
    const live = [row("b", "1"), row("a", "1")];
    expect(keepFrozenRowsFirst(live, null)).toBe(live);
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
