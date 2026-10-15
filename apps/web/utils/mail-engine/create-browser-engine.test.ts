import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMailEngine,
  prewarmMailEngineWorker,
} from "./create-browser-engine";

const wipe = vi.hoisted(() => ({
  finishPending: vi.fn(),
  isPending: vi.fn(() => false),
}));
const sqlite = vi.hoisted(() => ({ createStore: vi.fn() }));
const BUSY =
  "NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle";

vi.mock("@/utils/mail-engine/wipe-local-mailbox", () => ({
  finishPendingLocalMailboxWipe: wipe.finishPending,
  isLocalMailboxWipePending: wipe.isPending,
}));
vi.mock("@/utils/mail-engine/wasm-sqlite", () => ({
  createWasmMailStore: sqlite.createStore,
}));

describe("createBrowserMailEngine", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.onCreate = undefined;
    FakeWorker.startErrors = [];
    FakeWorker.rebuildOnStart = false;
    FakeWorker.startReplyDelayMs = 0;
    FakeWorker.startMessages = [];
    wipe.finishPending.mockResolvedValue(undefined);
    wipe.isPending.mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("finishes an interrupted sign-out wipe before opening the mailbox", async () => {
    const order: string[] = [];
    wipe.finishPending.mockImplementation(async () => {
      order.push("wipe");
    });
    FakeWorker.onCreate = () => order.push("worker");

    await startEngine();

    expect(order).toEqual(["wipe", "worker"]);
  });

  it("opens the mailbox in the worker started while the page loaded", async () => {
    prewarmMailEngineWorker();
    expect(FakeWorker.instances).toHaveLength(1);
    // Loaded early, it opens nothing until the engine starts it.
    expect(FakeWorker.instances[0].received("start")).toBe(0);

    await startEngine();

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].received("start")).toBe(1);
  });

  it("starts no worker early while a sign-out wipe is unfinished", () => {
    wipe.isPending.mockReturnValue(true);

    prewarmMailEngineWorker();

    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("lets go of an early worker this tab never needed", async () => {
    vi.useFakeTimers();
    prewarmMailEngineWorker();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeWorker.instances[0].terminated).toBe(true);
    const started = startEngine();
    await vi.runAllTimersAsync();
    await started;
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].received("start")).toBe(1);
  });

  it("retries in a fresh worker when the early one met a held mailbox", async () => {
    vi.useFakeTimers();
    FakeWorker.startErrors = [BUSY];
    prewarmMailEngineWorker();

    const started = startEngine();
    await vi.runAllTimersAsync();
    await started;

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].received("start")).toBe(1);
  });

  it("lets sign-out and the mail host close the same engine at once", async () => {
    const engine = await startEngine();
    const worker = FakeWorker.instances[0];

    await expect(
      Promise.all([engine.close(), engine.close()]),
    ).resolves.toEqual([undefined, undefined]);

    expect(worker.received("close")).toBe(1);
    expect(worker.terminated).toBe(true);
  });

  it("terminates a worker that failed to open the mailbox before falling back", async () => {
    // A worker that failed to start can still hold the mailbox's OPFS
    // handles, which the in-tab fallback (and every later tab) then needs.
    FakeWorker.startErrors = ["start failed"];
    sqlite.createStore.mockRejectedValue(new Error("QuotaExceededError"));

    await expect(startEngine()).rejects.toThrow("QuotaExceededError");

    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("retries a start while a closing tab still holds the mailbox files", async () => {
    vi.useFakeTimers();
    FakeWorker.startErrors = [BUSY, BUSY];

    const started = startEngine();
    await vi.runAllTimersAsync();

    await expect(started).resolves.toBeDefined();
    expect(FakeWorker.instances).toHaveLength(3);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].terminated).toBe(true);
    // The tab would contend for the same files, so it never opens them itself.
    expect(sqlite.createStore).not.toHaveBeenCalled();
  });

  it("stops retrying a held mailbox after a bounded wait", async () => {
    vi.useFakeTimers();
    FakeWorker.startErrors = Array.from({ length: 20 }, () => BUSY);

    const started = startEngine();
    const settled = expect(started).rejects.toThrow("Access Handles");
    await vi.runAllTimersAsync();

    await settled;
    expect(FakeWorker.instances.length).toBeGreaterThan(1);
    expect(FakeWorker.instances.length).toBeLessThan(20);
  });

  it("gives up on a mailbox another tab holds within about ten seconds", async () => {
    vi.useFakeTimers();
    // Each start waits out the other tab's file lock before reporting busy.
    FakeWorker.startReplyDelayMs = 10_000;
    FakeWorker.startErrors = Array.from({ length: 20 }, () => BUSY);
    const startedAt = Date.now();

    const started = startEngine();
    const settled = expect(started).rejects.toThrow("Access Handles");
    await vi.runAllTimersAsync();

    await settled;
    expect(Date.now() - startedAt).toBeLessThanOrEqual(12_000);
  });

  it("reports storage that cannot hold a mailbox without retrying", async () => {
    FakeWorker.startErrors = ["QuotaExceededError: quota exceeded"];
    sqlite.createStore.mockRejectedValue(new Error("QuotaExceededError"));

    await expect(startEngine()).rejects.toThrow("QuotaExceededError");

    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("tells the page while a corrupt mailbox is rebuilt", async () => {
    FakeWorker.rebuildOnStart = true;
    const onRebuild = vi.fn();

    await createBrowserMailEngine(
      {
        accountId: "account-1",
        provider: "google",
        online: false,
        ownedAccountIds: ["account-1"],
      },
      { onRebuild },
    );

    expect(onRebuild).toHaveBeenCalledOnce();
  });

  it("logs carried work a rebuild left out, without its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    FakeWorker.startMessages = [
      {
        type: "dropped",
        drop: { table: "drafts", reason: "rejected", count: 2 },
      },
    ];

    await startEngine();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("mail-engine"),
      expect.any(String),
      { table: "drafts", reason: "rejected", count: 2 },
    );
  });

  it("settles requests still waiting when the worker is terminated", async () => {
    const engine = await startEngine();
    FakeWorker.instances[0].silent.add("getDiagnostics");

    const diagnostics = engine.getDiagnostics("account-1");
    await engine.close();

    await expect(diagnostics).rejects.toThrow("mail engine worker closed");
  });
});

function startEngine() {
  return createBrowserMailEngine({
    accountId: "account-1",
    provider: "google",
    online: false,
    ownedAccountIds: ["account-1"],
  });
}

type Message = { id?: string; type: string; method?: string };

class FakeWorker {
  static instances: FakeWorker[] = [];
  static onCreate: (() => void) | undefined;
  static startErrors: string[] = [];
  static rebuildOnStart = false;
  static startReplyDelayMs = 0;
  static startMessages: unknown[] = [];
  readonly silent = new Set<string>();
  terminated = false;
  private readonly sent: Message[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.onCreate?.();
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(message: Message) {
    this.sent.push(message);
    if (message.method && this.silent.has(message.method)) return;
    // A real worker answers on a later task and never after it is terminated.
    setTimeout(
      () => {
        if (this.terminated || !message.id) return;
        const startError =
          message.type === "start" ? FakeWorker.startErrors.shift() : undefined;
        const replies: unknown[] = [
          ...(message.type === "start" && FakeWorker.rebuildOnStart
            ? [{ type: "rebuilding" }]
            : []),
          ...(message.type === "start" ? FakeWorker.startMessages : []),
          startError
            ? { id: message.id, type: "error", message: startError }
            : { id: message.id, type: "ok", value: undefined },
        ];
        for (const data of replies) {
          for (const listener of this.listeners) listener({ data });
        }
      },
      message.type === "start" ? FakeWorker.startReplyDelayMs : 0,
    );
  }

  terminate() {
    this.terminated = true;
  }

  received(type: string) {
    return this.sent.filter((message) => message.type === type).length;
  }
}
