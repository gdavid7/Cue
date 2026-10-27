import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_MAIL_ENGINE_CAPABILITIES,
  mailClientSupports,
} from "@inboxzero/mail-core/capabilities";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { supportsImportantPeople } from "@inboxzero/mail-core/important-people";
import type { QueryHandle, QuerySnapshot } from "@inboxzero/mail-core/queries";
import {
  bindTabMailOwner,
  createBroadcastTabBus,
  createMemoryTabBus,
  createTabFollowerClient,
  disposeTabFollowerClient,
  type TabMailBus,
  type TabMailMessage,
} from "./tab-channel";

describe("mail engine tab channel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("lets a follower subscribe and submit through the owner", async () => {
    const bus = createMemoryTabBus();
    const submitted: string[] = [];
    const owner = stubClient({
      onSubmit(commandId) {
        submitted.push(commandId);
      },
    });
    bindTabMailOwner({ client: owner, bus });
    const follower = createTabFollowerClient({ accountId: "acc-1", bus });
    const handle = follower.observeMailbox({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    await waitFor(() => handle.getSnapshot().status === "ready");
    expect(handle.getSnapshot().data?.counts.matchingConversations).toBe(1);
    const admission = await follower.submitMetadata({
      accountId: "acc-1",
      commandId: "archive-tab",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "archive" },
    });
    expect(admission.status).toBe("queued");
    expect(submitted).toEqual(["archive-tab"]);
    handle.close();
  });

  it("does not throw when posting to a closed BroadcastChannel", () => {
    const channel = {
      postMessage() {
        throw new DOMException("Channel is closed", "InvalidStateError");
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as BroadcastChannel;
    const bus = createBroadcastTabBus(channel);
    expect(() => bus.post({ type: "hello", accountId: "acc-1" })).not.toThrow();
  });

  it("rejects in-flight follower calls after dispose", async () => {
    const bus = createMemoryTabBus();
    const follower = createTabFollowerClient({ accountId: "acc-1", bus });
    const pending = follower.getDiagnostics("acc-1");
    disposeTabFollowerClient(follower);
    await expect(pending).rejects.toThrow("channel_closed");
  });

  it("lets one owner serve a second account after the follower announces it", async () => {
    const bus = createMemoryTabBus();
    const ensuredAccounts: string[] = [];
    bindTabMailOwner({
      client: stubClient({ onSubmit() {} }),
      bus,
      ensureAccount: async (account) => {
        ensuredAccounts.push(account.accountId);
      },
    });
    const follower = createTabFollowerClient({
      accountId: "acc-2",
      provider: "microsoft",
      bus,
    });

    await waitFor(() => ensuredAccounts.includes("acc-2"));
    expect(ensuredAccounts).toContain("acc-2");
    await expect(follower.getDiagnostics("acc-2")).resolves.toMatchObject({
      connection: "ready",
    });
  });

  it("rejects load more when the owner cannot serve a mailbox window", async () => {
    const bus = createMemoryTabBus();
    bindTabMailOwner({ client: stubClient({ onSubmit() {} }), bus });
    const follower = createTabFollowerClient({ accountId: "acc-1", bus });
    const handle = follower.observeMailboxWindow?.({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });

    await waitFor(() => handle?.getSnapshot().status === "ready");
    await expect(handle?.loadMore()).rejects.toThrow(
      "mailbox_window_unavailable",
    );
  });

  it("re-announces a follower when the owner becomes ready after a cold start", async () => {
    const bus = createMemoryTabBus();
    const follower = createTabFollowerClient({
      accountId: "acc-2",
      provider: "microsoft",
      bus,
    });
    const ensuredAccounts: string[] = [];

    bindTabMailOwner({
      client: stubClient({ onSubmit() {} }),
      bus,
      ensureAccount: async (account) => {
        ensuredAccounts.push(account.accountId);
      },
    });
    bus.post({ type: "ready" });

    await waitFor(() => ensuredAccounts.includes("acc-2"));
    expect(ensuredAccounts).toContain("acc-2");
    await expect(follower.getDiagnostics("acc-2")).resolves.toMatchObject({
      connection: "ready",
    });
  });

  it("moves a follower's views and unanswered calls to the tab that takes over as owner", async () => {
    const bus = createMemoryTabBus();
    const firstOwner = stubClient({ matchingConversations: 1 });
    const unbindFirst = bindTabMailOwner({ client: firstOwner, bus });
    const follower = createTabFollowerClient({ accountId: "acc-1", bus });
    const handle = follower.observeMailbox({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    await waitFor(() => handle.getSnapshot().status === "ready");
    expect(handle.getSnapshot().data?.counts.matchingConversations).toBe(1);

    // The owner tab closes; an archive sent meanwhile has no one to answer it.
    unbindFirst();
    const submitted: string[] = [];
    const admission = follower.submitMetadata({
      accountId: "acc-1",
      commandId: "archive-during-handoff",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "archive" },
    });

    bindTabMailOwner({
      client: stubClient({
        matchingConversations: 2,
        onSubmit: (commandId) => submitted.push(commandId),
      }),
      bus,
    });
    bus.post({ type: "ready" });

    await expect(admission).resolves.toMatchObject({ status: "queued" });
    expect(submitted).toEqual(["archive-during-handoff"]);
    await waitFor(
      () => handle.getSnapshot().data?.counts.matchingConversations === 2,
    );
    expect(handle.getSnapshot().data?.counts.matchingConversations).toBe(2);
    disposeTabFollowerClient(follower);
  });

  it("does not ask the owner to release deferred sends while offline", async () => {
    const bus = createMemoryTabBus();
    const syncs: string[][] = [];
    const owner = stubClient({
      onRequestSync(accountIds) {
        syncs.push(accountIds);
      },
    });
    bindTabMailOwner({ client: owner, bus });
    const follower = createTabFollowerClient({ accountId: "acc-1", bus });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(follower.requestSync(["acc-1"])).resolves.toEqual({
      status: "scheduled",
    });
    expect(syncs).toEqual([]);
    disposeTabFollowerClient(follower);
  });
});

describe("mail engine tab channel capability handshake", () => {
  it("gives a follower what a current owner's engine reported", async () => {
    const bus = createMemoryTabBus();
    bindTabMailOwner({
      client: {
        ...stubClient({}),
        capabilities: [
          ...BASELINE_MAIL_ENGINE_CAPABILITIES,
          "order:oldest_first",
          "method:queryPersonCard",
        ],
      },
      bus,
    });

    const follower = createTabFollowerClient({
      accountId: "acc-1",
      bus,
      capabilities: (await helloOwner(bus, "acc-1")).capabilities,
    });

    expect(mailClientSupports(follower, "order:oldest_first")).toBe(true);
    expect(mailClientSupports(follower, "method:queryPersonCard")).toBe(true);
    expect(mailClientSupports(follower, "method:searchSemantic")).toBe(false);
    disposeTabFollowerClient(follower);
  });

  it("reports what an owner's client answers when its engine reported nothing", async () => {
    const bus = createMemoryTabBus();
    bindTabMailOwner({
      client: { ...stubClient({}), async queryPersonCard() {} } as never,
      bus,
    });

    const owner = await helloOwner(bus, "acc-1");

    expect(owner.capabilities).toContain("method:queryPersonCard");
    expect(owner.capabilities).not.toContain("method:searchSemantic");
  });

  it("stars through the owner's engine, and hides stars behind an owner without them", async () => {
    const stars: unknown[] = [];
    const current = createMemoryTabBus();
    bindTabMailOwner({
      client: {
        ...stubClient({}),
        async queryImportantPeople() {
          return stars;
        },
        async setImportantPerson(input: unknown) {
          stars.push(input);
        },
      } as never,
      bus: current,
    });
    const follower = createTabFollowerClient({
      accountId: "acc-1",
      bus: current,
      capabilities: (await helloOwner(current, "acc-1")).capabilities,
    });
    expect(supportsImportantPeople(follower)).toBe(true);
    await follower.setImportantPerson?.({
      accountIds: ["acc-1"],
      email: "dana@example.com",
      important: true,
    });
    expect(await follower.queryImportantPeople?.(["acc-1"])).toHaveLength(1);
    disposeTabFollowerClient(follower);

    const older = createMemoryTabBus();
    bindOlderOwner(older);
    const behindOlder = createTabFollowerClient({
      accountId: "acc-1",
      bus: older,
      capabilities: (await helloOwner(older, "acc-1")).capabilities,
    });
    expect(supportsImportantPeople(behindOlder)).toBe(false);
    disposeTabFollowerClient(behindOlder);
  });

  it("suggests recipients through the owner's engine, and not behind an owner without them", async () => {
    const queryContactSuggestions = vi.fn(async () => [
      { emailAddress: "dana@example.com", name: "Dana" },
    ]);
    const current = createMemoryTabBus();
    bindTabMailOwner({
      client: { ...stubClient({}), queryContactSuggestions } as never,
      bus: current,
    });
    const follower = createTabFollowerClient({
      accountId: "acc-1",
      bus: current,
      capabilities: (await helloOwner(current, "acc-1")).capabilities,
    });
    const query = {
      accountId: "acc-1",
      query: "da",
      ownAddresses: ["me@example.com"],
      excludeEmails: [],
    };
    expect(mailClientSupports(follower, "method:queryContactSuggestions")).toBe(
      true,
    );
    await expect(follower.queryContactSuggestions?.(query)).resolves.toEqual([
      { emailAddress: "dana@example.com", name: "Dana" },
    ]);
    expect(queryContactSuggestions).toHaveBeenCalledWith(query);
    disposeTabFollowerClient(follower);

    const inTab = createMemoryTabBus();
    bindTabMailOwner({ client: stubClient({}), bus: inTab });
    const behindInTab = createTabFollowerClient({
      accountId: "acc-1",
      bus: inTab,
      capabilities: (await helloOwner(inTab, "acc-1")).capabilities,
    });
    expect(
      mailClientSupports(behindInTab, "method:queryContactSuggestions"),
    ).toBe(false);
    disposeTabFollowerClient(behindInTab);
  });

  it("assumes the baseline behind an owner tab that predates reporting", async () => {
    const bus = createMemoryTabBus();
    bindOlderOwner(bus);

    const owner = await helloOwner(bus, "acc-1");
    const follower = createTabFollowerClient({
      accountId: "acc-1",
      bus,
      capabilities: owner.capabilities,
    });

    expect(follower.capabilities).toBe(BASELINE_MAIL_ENGINE_CAPABILITIES);
    expect(mailClientSupports(follower, "order:oldest_first")).toBe(false);
    expect(mailClientSupports(follower, "method:queryPersonCard")).toBe(false);
    // The older owner still answers what it always did.
    await expect(follower.queryPersonCard?.({} as never)).rejects.toThrow(
      "unsupported method queryPersonCard",
    );
    disposeTabFollowerClient(follower);
  });

  it("serves a follower that predates reporting", async () => {
    const bus = createMemoryTabBus();
    bindTabMailOwner({
      client: { ...stubClient({}), capabilities: ["order:oldest_first"] },
      bus,
    });
    const answers: TabMailMessage[] = [];
    bus.subscribe((message) => {
      if (message.type === "ok") answers.push(message);
    });

    // Exactly what an older follower sends; it never reads capabilities.
    bus.post({ type: "hello", accountId: "acc-1" });
    bus.post({
      type: "call",
      id: "call-1",
      accountId: "acc-1",
      method: "getDiagnostics",
      args: ["acc-1"],
    });

    await waitFor(() => answers.length > 0);
    expect(answers[0]).toMatchObject({ type: "ok", id: "call-1" });
  });

  it("follows the report of the tab that takes over as owner", async () => {
    const bus = createMemoryTabBus();
    const unbindFirst = bindTabMailOwner({
      client: { ...stubClient({}), capabilities: ["order:oldest_first"] },
      bus,
    });
    const follower = createTabFollowerClient({
      accountId: "acc-1",
      bus,
      capabilities: (await helloOwner(bus, "acc-1")).capabilities,
    });
    expect(mailClientSupports(follower, "order:oldest_first")).toBe(true);

    // The owner tab closes and one running an older build takes over.
    unbindFirst();
    bindOlderOwner(bus);
    bus.post({ type: "ready" });

    await waitFor(
      () => follower.capabilities === BASELINE_MAIL_ENGINE_CAPABILITIES,
    );
    expect(mailClientSupports(follower, "order:oldest_first")).toBe(false);
    disposeTabFollowerClient(follower);
  });
});

/** Says hello as a tab looking for the owner, and resolves the owner's answer. */
function helloOwner(bus: TabMailBus, accountId: string) {
  return new Promise<Extract<TabMailMessage, { type: "owner" }>>((resolve) => {
    const unsubscribe = bus.subscribe((message) => {
      if (message.type !== "owner" || message.accountId !== accountId) return;
      unsubscribe();
      resolve(message);
    });
    bus.post({ type: "hello", accountId });
  });
}

/** An owner tab on a build from before capability reporting. */
function bindOlderOwner(bus: TabMailBus) {
  return bus.subscribe((message) => {
    if (message.type === "hello") {
      bus.post({ type: "owner", accountId: message.accountId });
      return;
    }
    if (message.type === "call") {
      bus.post({
        type: "error",
        id: message.id,
        message: `unsupported method ${message.method}`,
      });
    }
  });
}

function stubClient(input: {
  onSubmit?: (commandId: string) => void;
  onRequestSync?: (accountIds: string[]) => void;
  matchingConversations?: number;
}): MailClient {
  const snapshot: QuerySnapshot<{
    conversations: unknown[];
    counts: { matchingConversations: number; unreadConversations: number };
    coverage: unknown[];
    nextPage: null;
  }> = {
    status: "ready",
    revision: { databaseEpoch: "e", sequence: 1 },
    data: {
      conversations: [],
      counts: {
        matchingConversations: input.matchingConversations ?? 1,
        unreadConversations: 1,
      },
      coverage: [],
      nextPage: null,
    },
    refreshing: false,
    error: null,
  };
  function handle<T>(value: QuerySnapshot<T>): QueryHandle<T> {
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener);
        queueMicrotask(listener);
        return () => listeners.delete(listener);
      },
      close: () => listeners.clear(),
    };
  }
  return {
    observeMailbox: () => handle(snapshot as never),
    observeMailboxCounts: () => handle(snapshot as never),
    observeConversation: () => handle(snapshot as never),
    observeOperation: () => handle(snapshot as never),
    async submitMetadata(command) {
      input.onSubmit?.(command.commandId);
      return {
        status: "queued",
        operation: {
          accountId: command.accountId,
          operationId: command.commandId,
        },
        revision: { databaseEpoch: "e", sequence: 2 },
      };
    },
    async submitConversations() {
      return { status: "rejected", code: "unsupported" };
    },
    async saveDraft() {
      return { status: "rejected", code: "invalid" };
    },
    async readDraft() {
      return { status: "missing" };
    },
    async submitSend() {
      return { status: "rejected", code: "unsupported" };
    },
    async cancelOperation() {
      return { status: "not_found" };
    },
    async requestSync(accountIds) {
      input.onRequestSync?.(accountIds);
      return { status: "scheduled" };
    },
    async ensureMessageContent() {
      return { status: "scheduled" };
    },
    async getDiagnostics() {
      return {
        accountId: "acc-1",
        revision: { databaseEpoch: "e", sequence: 1 },
        connection: "ready",
        coverage: [],
        pendingOperations: 0,
        uncertainOperations: 0,
        pendingJobs: 0,
        oldestPendingAtMs: null,
        commands: [],
      };
    },
    async purgeAccount() {
      return { databaseEpoch: "e", sequence: 1 };
    },
    async retainAccounts() {},
  };
}

async function waitFor(match: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (match()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
