import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMailRecoveryStash,
  deleteMailRecoveryStash,
} from "./recovery-stash";

describe("createMailRecoveryStash", () => {
  it("holds work for this page when the browser has no IndexedDB", async () => {
    const stash = createMailRecoveryStash();
    const work = {
      accounts: [{ accountId: "acc-1", provider: "google", generation: "g1" }],
      drafts: [],
      operations: [],
      operationTargets: [],
      operationConversations: [],
    };

    await stash.write(work);
    expect(await stash.read()).toEqual(work);
    await stash.clear();
    expect(await stash.read()).toBeNull();
  });
});

describe("deleteMailRecoveryStash", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a stash it could not delete", async () => {
    const request = stubDeleteDatabase();

    const deleted = deleteMailRecoveryStash();
    request.onerror?.();

    await expect(deleted).resolves.toBe(false);
  });

  it("waits out a connection that briefly blocks the delete", async () => {
    const request = stubDeleteDatabase();

    const deleted = deleteMailRecoveryStash();
    request.onblocked?.();
    request.onsuccess?.();

    await expect(deleted).resolves.toBe(true);
  });

  it("gives up on a delete that stays blocked", async () => {
    vi.useFakeTimers();
    const request = stubDeleteDatabase();

    const deleted = deleteMailRecoveryStash();
    request.onblocked?.();
    await vi.runAllTimersAsync();

    await expect(deleted).resolves.toBe(false);
  });
});

function stubDeleteDatabase() {
  const request: {
    onsuccess?: () => void;
    onerror?: () => void;
    onblocked?: () => void;
  } = {};
  vi.stubGlobal("indexedDB", { deleteDatabase: () => request });
  return request;
}
