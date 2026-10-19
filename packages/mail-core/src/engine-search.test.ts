import { describe, expect, it } from "vitest";
import { createHostRuntime, createMailEngine } from "./engine";
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
    expect(view.getSnapshot().data?.providerSearch).toBe("complete");
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
    [
      { status: "paused", retryAfterMs: 60_000, reason: "unavailable" },
      "unavailable",
    ],
    [{ status: "unsupported" }, "unsupported"],
  ] as const)("tells the view when the provider answers %j", async (answer, state) => {
    const harness = searchHarness({ search: () => answer });
    const view = harness.engine.observeMailbox(searchQuery("larger:5M"));
    await harness.run();

    expect(view.getSnapshot().data?.providerSearch).toBe(state);
    view.close();
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
  search: (accountId: string) => Awaited<ReturnType<MailboxSource["search"]>>;
}) {
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
      return {
        status: "committed",
        revision: { databaseEpoch: "test", sequence: 1 },
      };
    },
    async enqueueHydration() {
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
    }: {
      predicate: MailPredicate;
      session: { accountId: string };
    }) {
      if (predicate.kind === "search") searches.push(predicate.query);
      return input.search(session.accountId);
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
    runtime: createHostRuntime(),
  });
  return {
    engine,
    searches,
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
