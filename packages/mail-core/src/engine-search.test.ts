import { describe, expect, it } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  SEARCH_CANCEL_GRACE_MS,
} from "./engine";
import type { ClaimedWork, MailStore } from "./ports/mail-store";
import type { MailboxSource } from "./ports/mailbox-source";
import type { ConversationQuery, MailboxView, MailPredicate } from "./queries";

// The engine's part of a typed search: asking the provider, keeping what it
// matched while a view is open, and handing it to the store with each read.
describe("typed searches in the engine", () => {
  it("adds the provider's exact matches to what the store reads, per account", async () => {
    const harness = searchHarness({
      search: (accountId) =>
        exact(accountId === "a" ? ["a-1", "a-2"] : ["b-1"], accountId),
    });
    const view = harness.engine.observeMailbox(
      searchQuery("larger:5M", { accountIds: ["a", "b"] }),
    );
    await harness.run();

    expect(harness.lastRead()).toEqual({
      kind: "all",
      predicates: [
        {
          kind: "any",
          predicates: [
            FALSE,
            {
              kind: "any",
              predicates: [
                { kind: "message", accountId: "a", ids: ["a-1", "a-2"] },
                { kind: "message", accountId: "b", ids: ["b-1"] },
              ],
            },
          ],
        },
        { kind: "mailbox", mailbox: "all" },
      ],
    });
    expect(view.getSnapshot().data?.providerSearch).toEqual([
      { accountId: "a", state: "complete", answered: true },
      { accountId: "b", state: "complete", answered: true },
    ]);
    view.close();
    await harness.engine.close();
  });

  it("keeps candidates out of the read when the provider only offers candidates", async () => {
    const harness = searchHarness({
      search: () => ({
        status: "ok",
        value: {
          matches: [{ accountId: "a", messageId: "candidate" }],
          nextPage: null,
          semantics: "candidates_require_local_filter",
        },
      }),
    });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();

    expect(harness.lastRead()).toEqual({
      kind: "all",
      predicates: [FALSE, { kind: "mailbox", mailbox: "all" }],
    });
    view.close();
    await harness.engine.close();
  });

  it("searches the provider once for a query whose local part changes", async () => {
    const harness = searchHarness({ search: () => exact(["gmail-1"]) });
    const first = harness.engine.observeMailbox(searchQuery("label:work"));
    await harness.run();
    // Labels loaded: the same query now has a local part.
    const second = harness.engine.observeMailbox(
      searchQuery("label:work", { local: LABEL_WORK }),
    );
    first.close();
    await harness.run();

    expect(harness.searches).toHaveLength(1);
    expect(harness.lastRead()).toMatchObject({
      predicates: [
        {
          kind: "any",
          predicates: [
            LABEL_WORK,
            { kind: "message", accountId: "a", ids: ["gmail-1"] },
          ],
        },
        { kind: "mailbox", mailbox: "all" },
      ],
    });
    second.close();
    await harness.engine.close();
  });

  it("keeps what was found for a view that closes and reopens the search", async () => {
    const harness = searchHarness({ search: () => exact(["gmail-1"]) });
    const first = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();
    first.close();
    const reopened = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();

    expect(harness.searches).toHaveLength(1);
    expect(JSON.stringify(harness.lastRead())).toContain("gmail-1");
    reopened.close();
    await harness.engine.close();
  });

  it("forgets released searches past the ones it keeps", async () => {
    const harness = searchHarness({ search: () => exact(["gmail-1"]) });
    for (let index = 0; index < 20; index++) {
      const view = harness.engine.observeMailbox(searchQuery(`q${index}`));
      await harness.run();
      view.close();
    }
    const reopened = harness.engine.observeMailbox(searchQuery("q0"));
    await harness.run();

    expect(harness.searches.filter((query) => query === "q0")).toHaveLength(2);
    reopened.close();
    await harness.engine.close();
  });

  it("doesn't ask the provider for a search still being typed", async () => {
    const harness = searchHarness({ search: () => exact(["gmail-1"]) });
    const view = harness.engine.observeMailbox({
      ...searchQuery("is:unr"),
      providerSearch: false,
    });
    await harness.run();

    expect(harness.searches).toEqual([]);
    expect(view.getSnapshot().data?.providerSearch).toBeUndefined();
    view.close();
    await harness.engine.close();
  });

  it.each([
    // Quota held it back: Gmail is busy, not gone.
    [{ status: "paused", retryAfterMs: 60_000, reason: "throttled" }, "busy"],
    [
      { status: "paused", retryAfterMs: 60_000, reason: "unavailable" },
      "unavailable",
    ],
    [{ status: "blocked_auth" }, "reconnect"],
    [{ status: "unsupported" }, "unsupported"],
  ] as const)("tells the view when the provider answers %j", async (answer, state) => {
    const harness = searchHarness({ search: () => answer });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();

    expect(view.getSnapshot().data?.providerSearch).toEqual([
      { accountId: "a", state, answered: false },
    ]);
    view.close();
    await harness.engine.close();
  });

  it("remembers that the provider answered when a later page is held back", async () => {
    let calls = 0;
    const harness = searchHarness({
      search: () => {
        calls += 1;
        if (calls > 1)
          return {
            status: "paused",
            retryAfterMs: 60_000,
            reason: "throttled",
          };
        return {
          status: "ok",
          value: {
            matches: [{ accountId: "a", messageId: "m1" }],
            nextPage: "page-2",
            semantics: "exact",
          },
        };
      },
    });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();
    await harness.run();

    expect(view.getSnapshot().data?.providerSearch).toEqual([
      { accountId: "a", state: "busy", answered: true },
    ]);
    view.close();
    await harness.engine.close();
  });

  it("asks the provider again for a search committed again after a minute", async () => {
    let now = 1_000_000;
    const harness = searchHarness({
      search: () => exact(["m1"]),
      nowMs: () => now,
    });
    const first = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();
    first.close();
    now += 10_000;
    const soon = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();
    soon.close();
    expect(harness.searches).toHaveLength(1);

    now += 61_000;
    const later = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();
    expect(harness.searches).toHaveLength(2);
    later.close();
    await harness.engine.close();
  });

  it("searches each account only with the query written for its provider", async () => {
    const harness = searchHarness({
      search: (accountId) => exact([`${accountId}-1`], accountId),
    });
    const query: ConversationQuery = {
      ...searchQuery("x", { accountIds: ["gmail", "outlook"] }),
      predicate: {
        kind: "any",
        predicates: [
          {
            kind: "search",
            query: "larger:5M",
            local: FALSE,
            possible: TRUE,
            accountIds: ["gmail"],
          },
          {
            kind: "search",
            query: "size>5MB",
            local: FALSE,
            possible: TRUE,
            accountIds: ["outlook"],
          },
        ],
      },
    };
    const view = harness.engine.observeMailbox(query);
    await harness.run();

    expect(harness.searchedBy).toEqual([
      ["gmail", "larger:5M"],
      ["outlook", "size>5MB"],
    ]);
    expect(harness.lastRead()).toEqual({
      kind: "any",
      predicates: [
        {
          kind: "all",
          predicates: [
            { kind: "account", ids: ["gmail"] },
            {
              kind: "any",
              predicates: [
                FALSE,
                { kind: "message", accountId: "gmail", ids: ["gmail-1"] },
              ],
            },
          ],
        },
        {
          kind: "all",
          predicates: [
            { kind: "account", ids: ["outlook"] },
            {
              kind: "any",
              predicates: [
                FALSE,
                { kind: "message", accountId: "outlook", ids: ["outlook-1"] },
              ],
            },
          ],
        },
      ],
    });
    view.close();
    await harness.engine.close();
  });

  it("says when the provider began a search, not when it was queued", async () => {
    let now = 1_000_000;
    const answer = deferred<Awaited<ReturnType<MailboxSource["search"]>>>();
    const harness = searchHarness({
      search: () => answer.promise,
      nowMs: () => now,
    });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await settle();
    expect(view.getSnapshot().data?.providerSearch).toEqual([
      { accountId: "a", state: "searching", answered: false },
    ]);

    now += 5000;
    const running = harness.engine.runUntil(Date.now() + 2000);
    await until(() => harness.searches.length === 1);
    await settle();
    expect(view.getSnapshot().data?.providerSearch).toEqual([
      {
        accountId: "a",
        state: "searching",
        answered: false,
        startedAtMs: 1_005_000,
      },
    ]);

    answer.resolve(exact(["m1"]));
    await running;
    view.close();
    await harness.engine.close();
  });

  it("stops a search no view wants any more, and fetches nothing it found", async () => {
    const answer = deferred<Awaited<ReturnType<MailboxSource["search"]>>>();
    const signals: AbortSignal[] = [];
    const harness = searchHarness({
      search: (_accountId, signal) => {
        signals.push(signal);
        return answer.promise;
      },
    });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    const running = harness.engine.runUntil(Date.now() + 5000);
    await until(() => signals.length === 1);

    view.close();
    await wait(SEARCH_CANCEL_GRACE_MS + 50);
    expect(signals[0].aborted).toBe(true);
    // The provider answers anyway: none of it is fetched.
    answer.resolve(exact(["m1", "m2"]));
    await running;
    expect(harness.hydrations).toEqual([]);

    // A view that wants it again asks afresh.
    const reopened = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await until(
      () => harness.searches.length === 2,
      () => harness.run(),
    );
    reopened.close();
    await harness.engine.close();
  });

  it("drops another account's queued search once nobody wants it", async () => {
    const answer = deferred<Awaited<ReturnType<MailboxSource["search"]>>>();
    const harness = searchHarness({ search: () => answer.promise });
    const view = harness.engine.observeMailbox(
      searchQuery("larger:5M", { accountIds: ["a", "b"] }),
    );
    const running = harness.engine.runUntil(Date.now() + 5000);
    await until(() => harness.searches.length === 1);

    view.close();
    await wait(SEARCH_CANCEL_GRACE_MS + 50);
    await running;
    await harness.run();

    expect(harness.searchedBy).toEqual([["a", "larger:5M"]]);
    expect(harness.hydrations).toEqual([]);
    await harness.engine.close();
  });

  it("keeps a search running for a view that picks it back up at once", async () => {
    const answer = deferred<Awaited<ReturnType<MailboxSource["search"]>>>();
    const signals: AbortSignal[] = [];
    const harness = searchHarness({
      search: (_accountId, signal) => {
        signals.push(signal);
        return answer.promise;
      },
    });
    const first = harness.engine.observeMailbox(searchQuery("larger:5M"));
    const running = harness.engine.runUntil(Date.now() + 5000);
    await until(() => signals.length === 1);

    first.close();
    const second = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await wait(SEARCH_CANCEL_GRACE_MS + 50);
    expect(signals[0].aborted).toBe(false);
    answer.resolve(exact(["m1"]));
    await running;

    expect(harness.searches).toHaveLength(1);
    expect(harness.hydrations).toContain("enqueue");
    second.close();
    await harness.engine.close();
  });
});

const FALSE: MailPredicate = { kind: "any", predicates: [] };
const TRUE: MailPredicate = { kind: "all", predicates: [] };
const LABEL_WORK: MailPredicate = {
  kind: "membership",
  membership: "label",
  id: "Label_work",
};

function searchQuery(
  query: string,
  options: { accountIds?: string[]; local?: MailPredicate } = {},
): ConversationQuery {
  return {
    accountIds: options.accountIds ?? ["a"],
    predicate: {
      kind: "all",
      predicates: [
        {
          kind: "search",
          query,
          local: options.local ?? FALSE,
          possible: TRUE,
        },
        { kind: "mailbox", mailbox: "all" },
      ],
    },
    order: "newest_first",
    pageSize: 25,
    after: null,
  };
}

function exact(
  ids: string[],
  accountId = "a",
): Awaited<ReturnType<MailboxSource["search"]>> {
  return {
    status: "ok",
    value: {
      matches: ids.map((messageId) => ({ accountId, messageId })),
      nextPage: null,
      semantics: "exact",
    },
  };
}

function searchHarness(input: {
  search: (
    accountId: string,
    signal: AbortSignal,
  ) =>
    | ReturnType<MailboxSource["search"]>
    | Awaited<ReturnType<MailboxSource["search"]>>;
  nowMs?: () => number;
}) {
  const hydrations: string[] = [];
  const searchedBy: Array<[string, string]> = [];
  const jobs: ClaimedWork[] = [];
  const reads: MailPredicate[] = [];
  const searches: string[] = [];
  let nextJob = 0;
  const store = {
    async enqueueSearch(job: {
      accountId: string;
      predicate: MailPredicate;
      page: string | null;
    }) {
      nextJob += 1;
      jobs.push({
        kind: "search",
        jobId: `job-${nextJob}`,
        attemptId: `attempt-${nextJob}`,
        accountId: job.accountId,
        session: { accountId: job.accountId, generation: "g1" },
        predicate: job.predicate,
        page: job.page,
      });
      return { databaseEpoch: "test", sequence: nextJob };
    },
    async claimWork() {
      return jobs.shift() ?? null;
    },
    async completeJob() {},
    async deferJob() {},
    async applyHydration() {
      hydrations.push("apply");
      return {
        status: "committed",
        revision: { databaseEpoch: "test", sequence: 1 },
      };
    },
    async enqueueHydration() {
      hydrations.push("enqueue");
      return { databaseEpoch: "test", sequence: 1 };
    },
    async indexContactBacklog() {
      return { remaining: false };
    },
    async indexSearchBacklog() {
      return { remaining: false };
    },
    async readAccountSyncStates() {
      return [];
    },
    async readMailboxView(query: ConversationQuery) {
      reads.push(query.predicate);
      return {
        revision: { databaseEpoch: "test", sequence: reads.length },
        view: emptyView(),
      };
    },
    async close() {},
  } as unknown as MailStore;
  const source = {
    async search({
      predicate,
      session,
      signal,
    }: {
      predicate: MailPredicate;
      session: { accountId: string };
      signal: AbortSignal;
    }) {
      if (predicate.kind === "search") {
        searches.push(predicate.query);
        searchedBy.push([session.accountId, predicate.query]);
      }
      return input.search(session.accountId, signal);
    },
  } as unknown as MailboxSource;
  const engine = createMailEngine({
    store,
    source,
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime(input.nowMs ? { nowMs: input.nowMs } : {}),
  });
  return {
    engine,
    hydrations,
    searches,
    searchedBy,
    lastRead: () => reads.at(-1),
    async run() {
      await engine.runUntil(Date.now() + 50);
      // Let views re-read after the work.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

function emptyView(): MailboxView {
  return {
    conversations: [],
    counts: {
      matchingConversations: 0,
      unreadConversations: 0,
      extent: "complete_scope",
    },
    nextPage: null,
    coverage: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settle() {
  return wait(10);
}

async function until(
  condition: () => boolean,
  step: () => Promise<unknown> = settle,
) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await step();
  expect(condition()).toBe(true);
}
