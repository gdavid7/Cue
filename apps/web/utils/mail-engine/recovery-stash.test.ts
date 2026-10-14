import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteMailRecoveryStash } from "./recovery-stash";

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
