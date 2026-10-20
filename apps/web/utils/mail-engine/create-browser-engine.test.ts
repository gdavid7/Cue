import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimEarlyMailEngineOwnerLock,
  createBrowserMailEngine,
  prewarmMailEngineWorker,
  releasePrewarmedMailEngineWorker,
} from "./create-browser-engine";
import { MAIL_ENGINE_OWNER_LOCK } from "./tab-channel";

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
    // Each test is a new page.
    releasePrewarmedMailEngineWorker();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("finishes an interrupted sign-out wipe before opening the mailbox", async () => {
    wipe.isPending.mockReturnValue(true);
    const order: string[] = [];
    wipe.finishPending.mockImplementation(async () => {
      order.push("wipe");
      wipe.isPending.mockReturnValue(false);
    });
    FakeWorker.onCreate = () => order.push("worker");

    await startEngine();

    expect(order).toEqual(["wipe", "worker"]);
  });

  it("wipes a mailbox signed out after the early worker opened it, and starts in a fresh worker", async () => {
    const locks = stubBrowserLocks();
    prewarmMailEngineWorker();
    const early = FakeWorker.instances[0];
    await vi.waitFor(() => expect(early.received("preopen")).toBe(1));
    const release = claimEarlyMailEngineOwnerLock();
    // Another tab signs out while this page hydrates.
    let pending = true;
    wipe.isPending.mockImplementation(() => pending);
    wipe.finishPending.mockImplementation(async () => {
      // The early worker holds the mailbox files until it is gone.
      if (early.terminated) pending = false;
    });

    await startEngine();

    expect(wipe.finishPending).toHaveBeenCalledOnce();
    expect(early.terminated).toBe(true);
    expect(early.received("start")).toBe(0);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].received("start")).toBe(1);
    // The start still owns the engine under the lock it claimed.
    expect(locks.held()).toBe(true);
    if (typeof release === "function") release();
  });

  it("opens no mailbox while a sign-out wipe cannot finish", async () => {
    prewarmMailEngineWorker();
    wipe.isPending.mockReturnValue(true);

    await expect(startEngine()).rejects.toThrow();

    expect(FakeWorker.instances.every((w) => w.received("start") === 0)).toBe(
      true,
    );
    expect(sqlite.createStore).not.toHaveBeenCalled();
  });

  it("starts in a fresh worker when the early one failed to load", async () => {
    prewarmMailEngineWorker();
    // Its script fails before the engine starts and listens for errors.
    FakeWorker.instances[0].fail("worker script failed");

    await startEngine();

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].received("start")).toBe(1);
  });

  it("starts under the claimed lock in a fresh worker when the early one idled out first", async () => {
    vi.useFakeTimers();
    const locks = stubBrowserLocks();
    prewarmMailEngineWorker();
    await vi.advanceTimersByTimeAsync(0);
    const release = claimEarlyMailEngineOwnerLock();

    await vi.advanceTimersByTimeAsync(30_000);
    const started = startEngine();
    await vi.runAllTimersAsync();
    await started;

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].received("start")).toBe(1);
    expect(locks.held()).toBe(true);
    if (typeof release === "function") release();
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

  it("opens the mailbox early under the engine's owner lock and hands the lock to the start", async () => {
    const locks = stubBrowserLocks();
    prewarmMailEngineWorker();
    await vi.waitFor(() =>
      expect(FakeWorker.instances[0].received("preopen")).toBe(1),
    );
    expect(locks.held()).toBe(true);

    const release = claimEarlyMailEngineOwnerLock();
    expect(release).toEqual(expect.any(Function));
    const starting = startEngine();
    // Sent in the same task: a phone's main thread can be busy for most of a
    // second after the effect that starts the engine.
    expect(FakeWorker.instances[0].received("start")).toBe(1);
    await starting;
    expect(FakeWorker.instances).toHaveLength(1);

    // Another tab becomes owner only once this page's engine lets go.
    const otherTab = locks.take();
    await settle();
    expect(otherTab.granted()).toBe(false);
    if (typeof release === "function") release();
    await vi.waitFor(() => expect(otherTab.granted()).toBe(true));
  });

  it("never opens the mailbox early while another tab holds the owner lock", async () => {
    vi.useFakeTimers();
    const locks = stubBrowserLocks();
    // Holding the lock is enough, even before that tab's engine has started
    // and announced itself.
    locks.take();
    await vi.advanceTimersByTimeAsync(0);
    prewarmMailEngineWorker();

    await vi.advanceTimersByTimeAsync(5000);

    expect(FakeWorker.instances[0].received("preopen")).toBe(0);
    expect(await claimEarlyMailEngineOwnerLock()).toBeNull();
  });

  it("opens the mailbox early once a page that just closed lets go of the lock", async () => {
    vi.useFakeTimers();
    const locks = stubBrowserLocks();
    const closingPage = locks.take();
    await vi.advanceTimersByTimeAsync(0);
    prewarmMailEngineWorker();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWorker.instances[0].received("preopen")).toBe(0);

    closingPage.release();
    await vi.advanceTimersByTimeAsync(100);

    expect(FakeWorker.instances[0].received("preopen")).toBe(1);
    expect(await claimEarlyMailEngineOwnerLock()).toEqual(expect.any(Function));
  });

  it("stops asking early once the engine's start asks for the lock itself", async () => {
    vi.useFakeTimers();
    const locks = stubBrowserLocks();
    const closingPage = locks.take();
    await vi.advanceTimersByTimeAsync(0);
    prewarmMailEngineWorker();
    await vi.advanceTimersByTimeAsync(150);

    expect(await claimEarlyMailEngineOwnerLock()).toBeNull();
    // The start's own request is next in line, and nothing jumps ahead of it.
    const start = locks.take();
    closingPage.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(start.granted()).toBe(true);
    expect(FakeWorker.instances[0].received("preopen")).toBe(0);
  });

  it("lets go of the owner lock with an early worker this page will not start", async () => {
    const locks = stubBrowserLocks();
    prewarmMailEngineWorker();
    await vi.waitFor(() => expect(locks.held()).toBe(true));

    // The page follows another tab or signs out.
    releasePrewarmedMailEngineWorker();

    expect(FakeWorker.instances[0].terminated).toBe(true);
    await vi.waitFor(() => expect(locks.held()).toBe(false));
    expect(await claimEarlyMailEngineOwnerLock()).toBeNull();
  });

  it("lets go of the owner lock when an early worker is never started", async () => {
    vi.useFakeTimers();
    const locks = stubBrowserLocks();
    prewarmMailEngineWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(locks.held()).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(locks.held()).toBe(false);
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

/**
 * Web Locks for one exclusive lock, granted in request order, and OPFS.
 * `take()` asks for the lock as another page would.
 */
function stubBrowserLocks() {
  type Request = { grant: () => void };
  const queue: Request[] = [];
  let holder: Request | null = null;
  const next = () => {
    if (holder) return;
    holder = queue.shift() ?? null;
    holder?.grant();
  };
  const request = (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => unknown,
  ) => {
    expect(name).toBe(MAIL_ENGINE_OWNER_LOCK);
    if (options.ifAvailable && (holder || queue.length > 0)) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise((resolve, reject) => {
      const entry: Request = {
        grant: () => {
          Promise.resolve()
            .then(() => callback({ name }))
            .then(resolve, reject)
            .finally(() => {
              holder = null;
              next();
            });
        },
      };
      queue.push(entry);
      next();
    });
  };
  vi.stubGlobal("navigator", {
    onLine: true,
    storage: { getDirectory: async () => ({}) },
    locks: { request },
  });
  return {
    held: () => holder !== null,
    take() {
      let granted = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      request(MAIL_ENGINE_OWNER_LOCK, {}, () => {
        granted = true;
        return held;
      });
      return { granted: () => granted, release: () => release() };
    },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  private dead = false;
  private readonly sent: Message[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private readonly errorListeners = new Set<
    (event: { message: string }) => void
  >();

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.onCreate?.();
  }

  addEventListener(
    type: string,
    listener: (event: { data: unknown; message: string }) => void,
  ) {
    if (type === "message") this.listeners.add(listener);
    if (type === "error") this.errorListeners.add(listener);
  }

  /** Its script fails: it reports an error and never answers again. */
  fail(message: string) {
    this.dead = true;
    for (const listener of this.errorListeners) listener({ message });
  }

  postMessage(message: Message) {
    this.sent.push(message);
    if (message.method && this.silent.has(message.method)) return;
    // A real worker answers on a later task and never after it is terminated.
    setTimeout(
      () => {
        if (this.terminated || this.dead || !message.id) return;
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
