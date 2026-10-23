import { describe, expect, it, vi } from "vitest";
import {
  createMailEngine,
  createHostRuntime,
} from "@inboxzero/mail-core/engine";
import type {
  MailboxSource,
  ScopeDescriptor,
} from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

describe("engine bootstrap coverage", () => {
  it("finishes enumeration after bootstrap overruns the runUntil slice", async () => {
    const onSyncPageCommitted = vi.fn();
    let now = 1000;
    let enumerated = 0;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      onSyncPageCommitted,
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {
          now = 5000;
        },
        onEnumerate: () => {
          enumerated += 1;
        },
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(2000);
    const diagnostics = await engine.getDiagnostics("acc-1");
    expect(enumerated).toBe(1);
    expect(onSyncPageCommitted).not.toHaveBeenCalled();
    expect(diagnostics.coverage).toEqual([
      expect.objectContaining({
        accountId: "acc-1",
        scopeId: "primary",
        metadata: "complete",
      }),
    ]);
    await engine.close();
  });

  it("shows a first sync's first page before the next page arrives", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const pages = slowBootstrapSource({
      onBootstrap: () => {},
      onEnumerate: () => {},
      pages: ["page-1", "page-2"],
    });
    let releaseSecondPage = () => {};
    const secondPageHeld = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const engine = createMailEngine({
      store,
      source: {
        ...pages,
        async enumerate(input) {
          if (input.page === "page-2") await secondPageHeld;
          return pages.enumerate(input);
        },
      },
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    const inbox = engine.observeMailbox({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    await engine.requestSync(["acc-1"]);
    const run = engine.runUntil(5000);

    await vi.waitFor(() =>
      expect(
        inbox
          .getSnapshot()
          .data?.conversations.map((item) => item.key.conversationId),
      ).toEqual(["c1"]),
    );

    releaseSecondPage();
    await run;
    inbox.close();
    await engine.close();
  });

  it("stores enumerated bodies so bootstrap content is available without hydrate", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        body: { html: "<p>First saved reply</p>", text: "First saved reply" },
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    const conversation = await store.readConversation(
      { accountId: "acc-1", conversationId: "c1" },
      { after: null, pageSize: 10 },
    );
    expect(conversation.view.messages[0]?.content).toEqual({
      status: "available",
      html: "<p>First saved reply</p>",
      text: null,
      attachments: [],
      isMeetingInvitation: false,
    });
    await engine.close();
  });

  it("removes local messages omitted from a completed bootstrap", async () => {
    const onSyncPageCommitted = vi.fn();
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "prior",
        from: { streamId: "account:all", generation: "g1", checkpoint: null },
        to: { streamId: "account:all", generation: "g1", checkpoint: "old" },
        changes: [messagePatch("gone", "c-gone", ["draft"])],
        requiredHydration: [],
        roundComplete: true,
      },
    });
    const engine = createMailEngine({
      onSyncPageCommitted,
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        readChangesOnce: { status: "reset_required", scopeId: "account:all" },
        scopeId: "account:all",
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    expect(onSyncPageCommitted).not.toHaveBeenCalled();
    const inspection = await engine.inspect();
    expect(
      inspection.messages.find((row) => row.messageId === "gone")?.deleted,
    ).toBe(true);
    expect(
      inspection.messages.find((row) => row.messageId === "m1")?.deleted,
    ).toBe(false);
    await engine.close();
  });

  it("resumes a multi-page bootstrap from the stored scan cursor", async () => {
    let now = 1000;
    let beginCalls = 0;
    const enumeratedPages: string[] = [];
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {
          beginCalls += 1;
        },
        onEnumerate: (page) => {
          enumeratedPages.push(page);
          // Each page uses up a whole bootstrap slice.
          now += 2000;
        },
        pages: ["page-1", "page-2"],
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(1500);
    expect(beginCalls).toBe(1);
    expect(enumeratedPages).toEqual(["page-1"]);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-2" });

    await engine.runUntil(5000);
    expect(beginCalls).toBe(1);
    expect(enumeratedPages).toEqual(["page-1", "page-2"]);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toBeNull();
    const view = await store.readMailboxView({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    expect(view.view.counts.matchingConversations).toBe(2);
    await engine.close();
  });

  it("lets a read queued during a sync run in between bootstrap pages", async () => {
    const events: string[] = [];
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => undefined,
        onEnumerate: (page) => {
          events.push(page);
          if (page !== "page-1") return;
          // Stands in for a window request arriving while page 1 is applied.
          setTimeout(() => {
            store.getDiagnostics("acc-1").then(() => events.push("read"));
          }, 0);
        },
        pages: ["page-1", "page-2", "page-3"],
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(2000);
    expect(events).toEqual(["page-1", "read", "page-2", "page-3"]);
    await engine.close();
  });

  it("passes the discovered folder scope descriptor into bootstrap", async () => {
    let receivedScope: ScopeDescriptor | null = null;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        scopeId: "folder:inbox",
        scopes: [
          { id: "folder:inbox", kind: "folder", folderId: "inbox-provider-id" },
        ],
        onBeginScope: (scope) => {
          receivedScope = scope;
        },
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    expect(receivedScope).toEqual({
      id: "folder:inbox",
      kind: "folder",
      folderId: "inbox-provider-id",
    });
    await engine.close();
  });

  it("starts every discovered folder in one pass after the time budget runs out", async () => {
    let now = 1000;
    const receivedScopes: string[] = [];
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "microsoft",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {
          now = 2000;
        },
        scopes: [
          { id: "folder:a", kind: "folder", folderId: "a" },
          { id: "folder:b", kind: "folder", folderId: "b" },
        ],
        onBeginScope: (scope) => {
          receivedScopes.push(scope.id);
        },
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(1500);
    expect(receivedScopes).toEqual(["folder:a", "folder:b"]);
    expect((await engine.getDiagnostics("acc-1")).coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeId: "folder:a", metadata: "complete" }),
        expect.objectContaining({ scopeId: "folder:b", metadata: "complete" }),
      ]),
    );

    await engine.runUntil(5000);
    expect(receivedScopes).toEqual(["folder:a", "folder:b"]);
    const inspection = await store.inspect();
    expect(inspection.streams.map((stream) => stream.streamId).sort()).toEqual([
      "folder:a",
      "folder:b",
    ]);
    await engine.close();
  });

  it("pauses a bootstrap scan when enumeration returns the same cursor", async () => {
    let enumerated = 0;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {
          enumerated += 1;
        },
        repeatNextPage: true,
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    expect(enumerated).toBe(1);
    const scan = await store.readBootstrapScan({
      session: { accountId: "acc-1", generation: "g1" },
      scopeId: "primary",
    });
    expect(scan).toMatchObject({
      page: "page-1",
      nextAttemptAtMs: 61_000,
      errorCode: "non_advancing_cursor",
    });
    await engine.runUntil(5000);
    expect(enumerated).toBe(1);
    await engine.close();
  });

  it("waits out a paused enumeration instead of retrying it every run", async () => {
    let now = 1000;
    let enumerated = 0;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {
          enumerated += 1;
        },
        pauseFirstEnumerationMs: 15_000,
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    await engine.runUntil(5000);
    expect(enumerated).toBe(1);

    now = 16_000;
    await engine.runUntil(20_000);
    expect(enumerated).toBe(2);
    expect((await engine.getDiagnostics("acc-1")).coverage).toEqual([
      expect.objectContaining({ scopeId: "primary", metadata: "complete" }),
    ]);
    await engine.close();
  });

  it("waits out the budget's hint before asking for the next page", async () => {
    let now = 1000;
    const pages: string[] = [];
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: (page) => pages.push(page),
        pages: ["page-1", "page-2"],
        nextPageRetryAfterMs: 6500,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    await engine.runUntil(5000);

    // The page landed and the next one waits, without a refused request.
    expect(pages).toEqual(["page-1"]);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-2", nextAttemptAtMs: 7500, errorCode: null });
    expect((await engine.getDiagnostics("acc-1")).connection).toBe("ready");

    now = 7500;
    await engine.runUntil(10_000);
    expect(pages).toEqual(["page-1", "page-2"]);
    expect((await engine.getDiagnostics("acc-1")).coverage).toEqual([
      expect.objectContaining({ scopeId: "primary", metadata: "complete" }),
    ]);
    await engine.close();
  });

  it("waits at most a minute however long a hint asks", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        pages: ["page-1", "page-2"],
        nextPageRetryAfterMs: 30 * 24 * 60 * 60 * 1000,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);

    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-2", nextAttemptAtMs: 61_000 });
    await engine.close();
  });

  it("asks for the next page at once when a page carries no hint", async () => {
    const pages: string[] = [];
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: (page) => pages.push(page),
        pages: ["page-1", "page-2"],
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);

    expect(pages).toEqual(["page-1", "page-2"]);
    await engine.close();
  });

  it("runs a user's action at once while the scan waits out a hint", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const execute = vi.fn(async () => ({
      status: "confirmed" as const,
      receiptId: null,
      observations: [],
      targets: [],
    }));
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        pages: ["page-1", "page-2"],
        nextPageRetryAfterMs: 60_000,
      }),
      executor: { ...uncertainExecutor(), execute },
      runtime: createHostRuntime({ nowMs: () => 1000 }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ nextAttemptAtMs: 61_000 });

    await engine.submitMetadata({
      accountId: "acc-1",
      commandId: "archive-1",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "archive" },
    });
    await engine.runUntil(5000);

    expect(execute).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("backs off further each time the scan is refused again", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        pages: ["page-1", "page-2"],
        enumerationRefusals: new Array(8).fill(1000),
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);

    const delays = await refusalDelays(engine, store, 8, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });

    // The first refusal waits the server's hint, so a single refusal costs
    // nothing extra; refusals in a row wait longer and longer, up to a cap.
    expect(delays[0]).toBe(1000);
    expect(delays[3]).toBeGreaterThanOrEqual(4000);
    expect(delays[4]).toBeGreaterThanOrEqual(7500);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(15_000);
    }
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(
      8 * 1000 * 4,
    );
    await engine.close();
  });

  it("starts over from the server's hint once a page lands", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        pages: ["page-1", "page-2", "page-3"],
        enumerationRefusals: [1000, 1000, 1000, 1000, 1000, null, 1000],
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);

    const clock = {
      now: () => now,
      advanceTo: (at: number) => {
        now = at;
      },
    };
    const before = await refusalDelays(engine, store, 5, clock);
    expect(before[4]).toBeGreaterThanOrEqual(7500);
    // The next run lands page-1, then page-2 is refused: a fresh first refusal.
    const [after] = await refusalDelays(engine, store, 1, clock);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-2", errorCode: "throttled" });
    expect(after).toBe(1000);
    await engine.close();
  });

  it("never asks again sooner than the server's own hint", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: [45_000, 45_000, 45_000],
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);

    const delays = await refusalDelays(engine, store, 3, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });
    expect(delays).toEqual([45_000, 45_000, 45_000]);
    await engine.close();
  });

  it("still runs a user's action at once while a refused scan backs off (guard)", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const execute = vi.fn(async () => ({
      status: "confirmed" as const,
      receiptId: null,
      observations: [],
      targets: [],
    }));
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: new Array(6).fill(1000),
      }),
      executor: { ...uncertainExecutor(), execute },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    const delays = await refusalDelays(engine, store, 5, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });
    expect(delays[4]).toBeGreaterThanOrEqual(7500);

    await engine.submitMetadata({
      accountId: "acc-1",
      commandId: "archive-1",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "archive" },
    });
    await engine.runUntil(now + 4000);

    expect(execute).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("doubles from the hint at the jitter's low end, up to the foreground cap", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: new Array(6).fill(1000),
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now, random: () => 0 }),
    });
    await engine.requestSync(["acc-1"]);
    const delays = await refusalDelays(engine, store, 6, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });
    expect(delays).toEqual([1000, 1000, 2000, 4000, 7500, 7500]);
    await engine.close();
  });

  it("waits exactly the hint, even under a second, on a first refusal", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: [700],
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    const delays = await refusalDelays(engine, store, 1, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });
    expect(delays).toEqual([700]);
    await engine.close();
  });

  it("does not grow the wait for refusals that are not throttling", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: new Array(6).fill({
          retryAfterMs: 1000,
          reason: "unavailable",
        }),
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    const delays = await refusalDelays(engine, store, 6, {
      now: () => now,
      advanceTo: (at) => {
        now = at;
      },
    });
    expect(delays).toEqual(new Array(6).fill(1000));
    await engine.close();
  });

  it("starts over from the hint when someone asks for a sync", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: new Array(6).fill(1000),
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    const clock = {
      now: () => now,
      advanceTo: (at: number) => {
        now = at;
      },
    };
    const before = await refusalDelays(engine, store, 5, clock);
    expect(before[4]).toBeGreaterThanOrEqual(7500);

    await engine.requestSync(["acc-1"]);
    expect(await refusalDelays(engine, store, 1, clock)).toEqual([1000]);
    await engine.close();
  });

  it("starts a re-added account's refusals over from the hint", async () => {
    let now = 1000;
    const refusals: Array<number | null> = new Array(6).fill(1000);
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        enumerationRefusals: refusals,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    const clock = {
      now: () => now,
      advanceTo: (at: number) => {
        now = at;
      },
    };
    const before = await refusalDelays(engine, store, 5, clock);
    expect(before[4]).toBeGreaterThanOrEqual(7500);

    await engine.purgeAccount("acc-1");
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    expect(await refusalDelays(engine, store, 1, clock)).toEqual([1000]);
    await engine.close();
  });

  it("keeps the account ready while a throttled enumeration waits", async () => {
    const now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        pauseFirstEnumerationMs: 15_000,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(5000);

    expect((await engine.getDiagnostics("acc-1")).connection).toBe("ready");
    await engine.close();
  });

  it("keeps a windowed first sync from counting as the whole mailbox", async () => {
    let now = 1000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        windowStartMs: 500,
        catchUpRounds: true,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    for (let round = 0; round < 5; round++) {
      now += 61_000;
      await engine.runUntil(now + 2000);
    }

    const [coverage] = (await engine.getDiagnostics("acc-1")).coverage;
    // The scan finished, so the account counts as synced, but only from the
    // window's start: catching up must not widen it.
    expect(coverage).toMatchObject({
      metadata: "complete",
      windowStartMs: 500,
    });
    expect(coverage?.lastCompletedSyncAtMs).not.toBeNull();
    // Older messages of a conversation may not be local, so opening one
    // still reads it from the provider.
    expect(
      await store.readConversationMembershipState(
        { accountId: "acc-1", conversationId: "c1" },
        now,
      ),
    ).toBe("incomplete");
    const { view } = await store.readMailboxView({
      accountIds: ["acc-1"],
      predicate: { kind: "mailbox", mailbox: "all" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    expect(view.counts.extent).toBe("local_coverage");
    await engine.close();
  });

  it("waits for the idle interval when the provider keeps asking for a resync", async () => {
    let now = 1000;
    let beginCalls = 0;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {
          beginCalls += 1;
        },
        onEnumerate: () => {},
        resetEveryRead: true,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);

    for (let elapsed = 0; elapsed < 59_000; elapsed += 250) {
      now += 250;
      await engine.runUntil(now + 2000);
    }

    // The first sync plus one resync; further resyncs wait for the interval.
    expect(beginCalls).toBe(2);
    await engine.close();
  });

  it("finishes a resync bootstrap that spans runs without waiting for the idle interval", async () => {
    let now = 1000;
    let readChangesCalls = 0;
    const pages = Array.from({ length: 30 }, (_, index) => `page-${index + 1}`);
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: slowBootstrapSource({
        onBootstrap: () => {},
        onEnumerate: () => {},
        onReadChanges: () => {
          readChangesCalls += 1;
        },
        readChangesOnce: { status: "reset_required", scopeId: "primary" },
        pages,
      }),
      executor: uncertainExecutor(),
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    await engine.requestSync(["acc-1"]);
    for (let run = 0; run < 3 && readChangesCalls === 0; run += 1) {
      now += 250;
      await engine.runUntil(now + 2000);
    }
    expect(readChangesCalls).toBe(1);
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-26" });

    for (let run = 0; run < 4; run += 1) {
      now += 250;
      await engine.runUntil(now + 2000);
    }

    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toBeNull();
    expect(readChangesCalls).toBe(1);
    await engine.close();
  });
  it("finishes a resync bootstrap left unfinished by an engine restart", async () => {
    let now = 1000;
    let readChangesCalls = 0;
    const pages = Array.from({ length: 30 }, (_, index) => `page-${index + 1}`);
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const source = slowBootstrapSource({
      onBootstrap: () => {},
      onEnumerate: () => {},
      onReadChanges: () => {
        readChangesCalls += 1;
      },
      readChangesOnce: { status: "reset_required", scopeId: "primary" },
      pages,
    });
    const createEngine = () =>
      createMailEngine({
        store,
        source,
        executor: uncertainExecutor(),
        runtime: createHostRuntime({ nowMs: () => now }),
      });
    const beforeRestart = createEngine();
    await beforeRestart.requestSync(["acc-1"]);
    for (let run = 0; run < 3 && readChangesCalls === 0; run += 1) {
      now += 250;
      await beforeRestart.runUntil(now + 2000);
    }
    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toMatchObject({ page: "page-26" });

    const afterRestart = createEngine();
    for (let run = 0; run < 4; run += 1) {
      now += 250;
      await afterRestart.runUntil(now + 2000);
    }

    expect(
      await store.readBootstrapScan({
        session: { accountId: "acc-1", generation: "g1" },
        scopeId: "primary",
      }),
    ).toBeNull();
    await afterRestart.close();
  });
});

// Runs the engine until the scan is refused `count` times, moving the clock to
// each retry time, and returns how long each refusal made the scan wait.
async function refusalDelays(
  engine: { runUntil(deadlineMs: number): Promise<void> },
  store: Awaited<ReturnType<typeof createSqliteMailStore>>,
  count: number,
  clock: { now(): number; advanceTo(at: number): void },
) {
  const delays: number[] = [];
  for (let refusal = 0; refusal < count; refusal++) {
    await engine.runUntil(clock.now() + 4000);
    const scan = await store.readBootstrapScan({
      session: { accountId: "acc-1", generation: "g1" },
      scopeId: "primary",
    });
    if (scan?.nextAttemptAtMs == null) break;
    delays.push(scan.nextAttemptAtMs - clock.now());
    clock.advanceTo(scan.nextAttemptAtMs);
  }
  return delays;
}

function uncertainExecutor() {
  return {
    async execute() {
      return { status: "uncertain" as const, receiptId: null };
    },
    async inspect() {
      return { status: "uncertain" as const, receiptId: null };
    },
  };
}

function slowBootstrapSource(hooks: {
  onBootstrap: () => void;
  onEnumerate: (page: string) => void;
  readChangesOnce?: { status: "reset_required"; scopeId: string };
  resetEveryRead?: boolean;
  onReadChanges?: () => void;
  body?: { html: string | null; text: string | null };
  scopeId?: string;
  pages?: string[];
  scopes?: ScopeDescriptor[];
  onBeginScope?: (scope: ScopeDescriptor) => void;
  repeatNextPage?: boolean;
  pauseFirstEnumerationMs?: number;
  /**
   * One entry per enumerate call: a throttled refusal's retryAfterMs, a
   * refusal with its reason, or null to answer.
   */
  enumerationRefusals?: Array<
    | number
    | { retryAfterMs: number; reason: "throttled" | "unavailable" }
    | null
  >;
  nextPageRetryAfterMs?: number;
  windowStartMs?: number;
  catchUpRounds?: boolean;
}): MailboxSource {
  const pages = hooks.pages ?? ["page-1"];
  const changesByPage = new Map(
    pages.map((page, index) => [
      page,
      messagePatch(`m${index + 1}`, `c${index + 1}`, ["inbox"]),
    ]),
  );
  const firstChange =
    changesByPage.get(pages[0] ?? "page-1") ??
    messagePatch("m1", "c1", ["inbox"]);
  let resetConsumed = false;
  let enumerationPaused = false;
  let activeScopeId = hooks.scopeId ?? "primary";
  return {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: ["archive"],
          maxPageSize: 50,
          maxHydrationBatch: 20,
        },
      };
    },
    async discoverScopes() {
      return {
        status: "ok",
        value: {
          scopes: hooks.scopes ?? [
            { id: "primary", kind: "account", folderId: null },
          ],
          nextPage: null,
        },
      };
    },
    async beginBootstrap(input) {
      hooks.onBootstrap();
      hooks.onBeginScope?.(input.scope);
      activeScopeId = input.scope.id;
      return {
        status: "ok",
        value: {
          bootstrapId: "boot",
          enumerationToken: "page-1",
          catchUpFrom: null,
        },
      };
    },
    async enumerate(input) {
      hooks.onEnumerate(input.page);
      if (hooks.pauseFirstEnumerationMs && !enumerationPaused) {
        enumerationPaused = true;
        return {
          status: "paused",
          retryAfterMs: hooks.pauseFirstEnumerationMs,
          reason: "throttled",
        };
      }
      const refusal = hooks.enumerationRefusals?.shift();
      if (typeof refusal === "number") {
        return { status: "paused", retryAfterMs: refusal, reason: "throttled" };
      }
      if (refusal) return { status: "paused", ...refusal };
      const change =
        changesByPage.get(input.page) ??
        messagePatch("m-missing", "c-missing", ["inbox"]);
      const pageIndex = pages.indexOf(input.page);
      const nextPage = hooks.repeatNextPage
        ? input.page
        : pageIndex >= 0
          ? (pages[pageIndex + 1] ?? null)
          : null;
      const base = {
        bootstrapId: "boot",
        scopeId: activeScopeId,
        changes: [change],
        requiredHydration: [],
        bodies: hooks.body
          ? [
              {
                key: { accountId: "acc-1", messageId: "m1" },
                version: "1",
                html: hooks.body.html,
                text: hooks.body.text,
              },
            ]
          : [],
      };
      return {
        status: "ok",
        value: nextPage
          ? {
              ...base,
              nextPage,
              catchUpFrom: null,
              ...(hooks.nextPageRetryAfterMs !== undefined && {
                retryAfterMs: hooks.nextPageRetryAfterMs,
              }),
            }
          : {
              ...base,
              nextPage: null,
              catchUpFrom: {
                streamId: activeScopeId,
                generation: "g1",
                checkpoint: "enumerated",
              },
              ...(hooks.windowStartMs !== undefined && {
                windowStartMs: hooks.windowStartMs,
              }),
            },
      };
    },
    async readChanges(input) {
      hooks.onReadChanges?.();
      if (hooks.resetEveryRead) {
        return { status: "reset_required", scopeId: activeScopeId };
      }
      if (hooks.readChangesOnce && !resetConsumed) {
        resetConsumed = true;
        return hooks.readChangesOnce;
      }
      if (hooks.catchUpRounds) {
        return {
          status: "page",
          page: {
            session: input.session,
            requestId: input.requestId,
            from: input.position,
            to: input.position,
            changes: [],
            requiredHydration: [],
            roundComplete: true,
          },
        };
      }
      return { status: "paused", retryAfterMs: 0, reason: "unavailable" };
    },
    async hydrate() {
      return {
        status: "ok",
        value: { changes: [], bodies: [], unresolved: [] },
      };
    },
    async readConversationMembership({ conversation }) {
      return {
        status: "ok",
        value: {
          status: "page",
          page: {
            conversation,
            resolutionId: "res",
            keys: [firstChange.key],
            changes: [],
            nextPage: null,
            evidence: null,
          },
        },
      };
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return { status: "paused", retryAfterMs: 0, reason: "unavailable" };
    },
  };
}

function messagePatch(
  messageId: string,
  conversationId: string,
  roles: Array<"inbox" | "draft">,
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider: "google",
      messageId,
      conversationId,
      version: "1",
    },
    fields: {
      subject: messageId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: false,
      starred: false,
      folderId: roles.includes("inbox") ? "inbox" : null,
      labelIds: roles.includes("inbox") ? ["INBOX"] : ["DRAFT"],
      categoryIds: [],
      roles,
      hasAttachments: false,
    },
  };
}
