import { describe, expect, it, vi } from "vitest";
import type { MailEngine } from "@inboxzero/mail-core/engine";
import { createMailWorkerHost } from "./worker-session";
import type { WorkerResponse } from "./worker-protocol";

describe("mail worker account fencing", () => {
  it("rejects a second account while the first engine is still starting", async () => {
    const posts: WorkerResponse[] = [];
    let createCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createMailWorkerHost({
      async createEngine() {
        createCount += 1;
        await gate;
        return stubEngine();
      },
      post: (message) => posts.push(message),
    });

    const first = host.handle({
      id: "start-1",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });
    const second = host.handle({
      id: "start-2",
      type: "start",
      input: { accountId: "acc-2", provider: "microsoft" },
    });
    release();
    await Promise.all([first, second]);

    expect(createCount).toBe(1);
    expect(posts).toEqual([
      { id: "start-1", type: "ok" },
      { id: "start-2", type: "error", message: "account_mismatch" },
    ]);
  });

  it("reuses the running engine for the same account", async () => {
    const posts: WorkerResponse[] = [];
    let createCount = 0;
    const host = createMailWorkerHost({
      async createEngine() {
        createCount += 1;
        return stubEngine();
      },
      post: (message) => posts.push(message),
    });

    await host.handle({
      id: "start-1",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });
    await host.handle({
      id: "start-1b",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });

    expect(createCount).toBe(1);
    expect(posts).toEqual([
      { id: "start-1", type: "ok" },
      { id: "start-1b", type: "ok" },
    ]);
  });

  it("allows a different account after close", async () => {
    const posts: WorkerResponse[] = [];
    const created: string[] = [];
    const host = createMailWorkerHost({
      async createEngine(input) {
        created.push(input.accountId);
        return stubEngine();
      },
      post: (message) => posts.push(message),
    });

    await host.handle({
      id: "start-1",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });
    await host.handle({ id: "close-1", type: "close" });
    await host.handle({
      id: "start-2",
      type: "start",
      input: { accountId: "acc-2", provider: "microsoft" },
    });

    expect(created).toEqual(["acc-1", "acc-2"]);
    expect(posts).toEqual([
      { id: "start-1", type: "ok" },
      { id: "close-1", type: "ok" },
      { id: "start-2", type: "ok" },
    ]);
  });
});

describe("mail worker snapshots", () => {
  it("sends every view a write refreshed in one message, before the write's answer", async () => {
    const posts: WorkerResponse[] = [];
    const views = new Map<string, StubView>();
    const engine = {
      ...stubEngine(),
      observeMailbox: () => stubView(views, "list"),
      observeMailboxCounts: () => stubView(views, "counts"),
      async submitConversations() {
        views.get("list")?.publish("archived");
        views.get("counts")?.publish("one fewer");
        return { status: "accepted" };
      },
    } as unknown as MailEngine;
    const host = createMailWorkerHost({
      createEngine: async () => engine,
      post: (message) => posts.push(message),
    });
    await host.handle({
      id: "start",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });
    await host.handle({
      id: "observe-list",
      type: "observe",
      kind: "mailbox",
      handleId: "list",
      args: [],
    });
    await host.handle({
      id: "observe-counts",
      type: "observe",
      kind: "mailboxCounts",
      handleId: "counts",
      args: [],
    });
    posts.length = 0;

    await host.handle({
      id: "archive",
      type: "call",
      method: "submitConversations",
      args: [],
    });

    expect(posts).toEqual([
      {
        type: "snapshots",
        snapshots: [
          { handleId: "list", snapshot: readySnapshot("archived") },
          { handleId: "counts", snapshot: readySnapshot("one fewer") },
        ],
      },
      { id: "archive", type: "ok", value: { status: "accepted" } },
    ]);
  });

  it("sends a refresh with no pending answer on the next task", async () => {
    vi.useFakeTimers();
    const posts: WorkerResponse[] = [];
    const views = new Map<string, StubView>();
    const host = createMailWorkerHost({
      createEngine: async () =>
        ({
          ...stubEngine(),
          observeMailbox: () => stubView(views, "list"),
        }) as unknown as MailEngine,
      post: (message) => posts.push(message),
    });
    await host.handle({
      id: "start",
      type: "start",
      input: { accountId: "acc-1", provider: "google" },
    });
    await host.handle({
      id: "observe-list",
      type: "observe",
      kind: "mailbox",
      handleId: "list",
      args: [],
    });
    posts.length = 0;

    views.get("list")?.publish("synced");
    views.get("list")?.publish("synced again");
    expect(posts).toEqual([]);
    await vi.runAllTimersAsync();

    expect(posts).toEqual([
      {
        type: "snapshots",
        snapshots: [
          { handleId: "list", snapshot: readySnapshot("synced again") },
        ],
      },
    ]);
    vi.useRealTimers();
  });
});

type StubView = { publish: (data: string) => void };

function stubView(views: Map<string, StubView>, name: string) {
  let snapshot = readySnapshot("initial");
  const listeners = new Set<() => void>();
  views.set(name, {
    publish(data) {
      snapshot = readySnapshot(data);
      for (const listener of listeners) listener();
    },
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };
}

function readySnapshot(data: string) {
  return {
    status: "ready" as const,
    revision: null,
    data,
    refreshing: false,
    error: null,
  };
}

function stubEngine(): MailEngine {
  return {
    async close() {},
  } as MailEngine;
}
