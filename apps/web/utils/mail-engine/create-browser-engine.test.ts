import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMailEngine } from "./create-browser-engine";

const wipe = vi.hoisted(() => ({ finishPending: vi.fn() }));
const sqlite = vi.hoisted(() => ({ createDriver: vi.fn() }));

vi.mock("@/utils/mail-engine/wipe-local-mailbox", () => ({
  finishPendingLocalMailboxWipe: wipe.finishPending,
}));
vi.mock("@/utils/mail-engine/wasm-sqlite", () => ({
  createWasmSqliteDriver: sqlite.createDriver,
}));

describe("createBrowserMailEngine", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.onCreate = undefined;
    FakeWorker.failStart = false;
    wipe.finishPending.mockResolvedValue(undefined);
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
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
    FakeWorker.failStart = true;
    sqlite.createDriver.mockRejectedValue(
      new Error("NoModificationAllowedError"),
    );

    await expect(startEngine()).rejects.toThrow("NoModificationAllowedError");

    expect(FakeWorker.instances[0].terminated).toBe(true);
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
  });
}

type Message = { id?: string; type: string; method?: string };

class FakeWorker {
  static instances: FakeWorker[] = [];
  static onCreate: (() => void) | undefined;
  static failStart = false;
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
    setTimeout(() => {
      if (this.terminated || !message.id) return;
      const data =
        message.type === "start" && FakeWorker.failStart
          ? { id: message.id, type: "error", message: "start failed" }
          : { id: message.id, type: "ok", value: undefined };
      for (const listener of this.listeners) listener({ data });
    }, 0);
  }

  terminate() {
    this.terminated = true;
  }

  received(type: string) {
    return this.sent.filter((message) => message.type === type).length;
  }
}
