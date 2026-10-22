import { describe, expect, it, vi } from "vitest";
import { createInTabEngine } from "./in-tab-engine";

vi.mock("@inboxzero/mail-core/engine", () => ({
  createHostRuntime: vi.fn(() => ({})),
  createMailEngine: vi.fn(() => ({
    searchMessages: vi.fn(),
    queryContactSuggestions: vi.fn(),
    requestSync: vi.fn(async () => ({ status: "accepted" })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock("@inboxzero/mail-core/protocol/routed-backend-adapter", () => ({
  createRoutedBackendAdapter: vi.fn(() => ({})),
}));
vi.mock("@/utils/mail-engine/wasm-sqlite", () => ({
  createWasmMailStore: vi.fn(async () => ({ ensureAccount: vi.fn() })),
}));
vi.mock("@/utils/mail-engine/engine-loop", () => ({
  startEngineLoop: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
}));

describe("createInTabEngine", () => {
  it("keeps store reads that could scan the mailbox off the UI thread", async () => {
    const engine = await createInTabEngine(
      {
        accountId: "account-1",
        provider: "google",
        online: false,
        ownedAccountIds: ["account-1"],
      } as never,
      {} as never,
    );

    // The assistant searches Gmail instead, and autocomplete stays off.
    expect(engine.searchMessages).toBeUndefined();
    expect(engine.queryContactSuggestions).toBeUndefined();
    expect(engine.queryNeverReadSenders).toBeUndefined();
  });
});
