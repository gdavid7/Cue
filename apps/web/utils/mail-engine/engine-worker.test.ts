import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserEngineStart,
  WorkerPreopenRequest,
  WorkerRequest,
} from "./worker-protocol";

const sqlite = vi.hoisted(() => ({ createStore: vi.fn() }));
const BUSY =
  "NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle";

vi.mock("./wasm-sqlite", () => ({
  createWasmMailStore: sqlite.createStore,
  preloadSqlite: async () => ({}),
}));
vi.mock("@inboxzero/mail-core/engine", () => ({
  createHostRuntime: () => ({}),
  createMailEngine: () => ({
    requestSync: async () => ({ status: "scheduled" }),
    close: async () => undefined,
  }),
}));
vi.mock("./engine-loop", () => ({
  startEngineLoop: () => ({ stop: async () => undefined }),
}));
vi.mock("@inboxzero/mail-core/protocol/routed-backend-adapter", () => ({
  createRoutedBackendAdapter: () => ({}),
}));

type StoreInput = {
  persist?: boolean;
  ownedAccountIds: string[] | Promise<string[]>;
  options?: { maxPendingOperations?: number };
};

describe("engine worker", () => {
  let posted: Array<{ id?: string; type: string; message?: string }>;
  let send: (message: WorkerRequest | WorkerPreopenRequest) => void;

  beforeEach(async () => {
    posted = [];
    const self: {
      postMessage: (message: never) => void;
      onmessage: ((event: { data: unknown }) => void) | null;
    } = {
      postMessage: (message) => posted.push(message),
      onmessage: null,
    };
    vi.stubGlobal("self", self);
    // Each test is a new worker.
    vi.resetModules();
    await import("./engine-worker");
    send = (message) => self.onmessage?.({ data: message });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts on the mailbox opened early", async () => {
    const early = fakeStore();
    sqlite.createStore.mockResolvedValueOnce(early);

    send({ type: "preopen", maxPendingOperations: 5 });
    send(startRequest({ maxPendingOperations: 5 }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    expect(sqlite.createStore).toHaveBeenCalledOnce();
    // The start names the accounts a rebuild may carry work for.
    await expect(storeInput(0).ownedAccountIds).resolves.toEqual(["account-1"]);
    expect(early.ensureAccount).toHaveBeenCalled();
    expect(early.close).not.toHaveBeenCalled();
  });

  it("opens nothing early once the engine has started", async () => {
    sqlite.createStore.mockResolvedValue(fakeStore());

    send(startRequest({ maxPendingOperations: 5 }));
    send({ type: "preopen", maxPendingOperations: 5 });

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    await settle();
    expect(sqlite.createStore).toHaveBeenCalledOnce();
    expect(storeInput(0).ownedAccountIds).toEqual(["account-1"]);
  });

  it("closes the early mailbox, running no recovery, for a start with other limits", async () => {
    const early = fakeStore();
    const own = fakeStore();
    // A mailbox with carried work waits for the accounts before restoring it.
    sqlite.createStore.mockImplementationOnce(async (input: StoreInput) => {
      await input.ownedAccountIds;
      return early;
    });
    sqlite.createStore.mockResolvedValueOnce(own);

    send({ type: "preopen", maxPendingOperations: 5 });
    send(startRequest({ maxPendingOperations: 10 }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    await expect(storeInput(0).ownedAccountIds).rejects.toThrow();
    expect(storeInput(1).options?.maxPendingOperations).toBe(10);
    expect(own.ensureAccount).toHaveBeenCalled();
  });

  it("opens an in-memory mailbox for a start that keeps none, running no recovery early", async () => {
    sqlite.createStore.mockImplementationOnce(async (input: StoreInput) => {
      await input.ownedAccountIds;
      return fakeStore();
    });
    sqlite.createStore.mockResolvedValueOnce(fakeStore());

    send({ type: "preopen" });
    send(startRequest({ persist: false }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    await expect(storeInput(0).ownedAccountIds).rejects.toThrow();
    expect(storeInput(1).persist).toBe(false);
  });

  it("closes an early mailbox a start does not want", async () => {
    const early = fakeStore();
    sqlite.createStore.mockResolvedValueOnce(early);
    sqlite.createStore.mockResolvedValueOnce(fakeStore());

    send({ type: "preopen", maxPendingOperations: 5 });
    send(startRequest({ maxPendingOperations: 10 }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    expect(early.close).toHaveBeenCalledOnce();
  });

  it("opens the mailbox again when the early open met files a closing tab held", async () => {
    sqlite.createStore.mockRejectedValueOnce(new Error(BUSY));
    sqlite.createStore.mockResolvedValueOnce(fakeStore());

    send({ type: "preopen", maxPendingOperations: 5 });
    send(startRequest({ maxPendingOperations: 5 }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("ok"));
    expect(sqlite.createStore).toHaveBeenCalledTimes(2);
  });

  it("reports an early open that failed for good to the start", async () => {
    sqlite.createStore.mockRejectedValueOnce(
      new Error("QuotaExceededError: quota exceeded"),
    );
    sqlite.createStore.mockResolvedValue(fakeStore());

    send({ type: "preopen", maxPendingOperations: 5 });
    send(startRequest({ maxPendingOperations: 5 }));

    await vi.waitFor(() => expect(reply("start-1")?.type).toBe("error"));
    expect(reply("start-1")?.message).toContain("QuotaExceededError");
    expect(sqlite.createStore).toHaveBeenCalledOnce();
  });

  function reply(id: string) {
    return posted.find((message) => message.id === id);
  }
});

function storeInput(call: number) {
  return sqlite.createStore.mock.calls[call]?.[0] as StoreInput;
}

function fakeStore() {
  return {
    ensureAccount: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function startRequest(input: Partial<BrowserEngineStart>): WorkerRequest {
  return {
    id: "start-1",
    type: "start",
    input: {
      accountId: "account-1",
      provider: "google",
      online: false,
      ownedAccountIds: ["account-1"],
      ...input,
    },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
