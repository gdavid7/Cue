/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishPendingLocalMailboxWipe,
  wipeLocalMailbox,
} from "./wipe-local-mailbox";

const desktop = vi.hoisted(() => ({
  wipeMailbox: vi.fn(),
  app: undefined as { wipeMailbox?: () => Promise<void> } | undefined,
}));
const opfs = vi.hoisted(() => ({ wipe: vi.fn() }));
const engine = vi.hoisted(() => ({ close: vi.fn() }));
const offlineCache = vi.hoisted(() => ({ clear: vi.fn() }));
const senderQueue = vi.hoisted(() => ({ clear: vi.fn() }));
const searchHistory = vi.hoisted(() => ({ clear: vi.fn() }));

vi.mock("@/utils/desktop-app", () => ({
  getInboxZeroDesktopApp: () => desktop.app,
}));
vi.mock("@/utils/mail-engine/opfs-mailbox", () => ({
  wipeOpfsMailEngine: () => opfs.wipe(),
}));
vi.mock("@/utils/mail-engine/active-client", () => ({
  closeActiveMailEngine: () => engine.close(),
}));
vi.mock("@/utils/offline/clear-mail-cache", () => ({
  clearOfflineMailCache: () => offlineCache.clear(),
}));
vi.mock("@/store/sender-queue", () => ({
  clearStoredSenderQueues: () => senderQueue.clear(),
}));
vi.mock("@/store/mail-search-history", () => ({
  clearRecentSearchHistory: () => searchHistory.clear(),
}));

describe("wipeLocalMailbox", () => {
  beforeEach(() => {
    engine.close.mockResolvedValue(undefined);
    offlineCache.clear.mockResolvedValue(undefined);
  });

  afterEach(() => {
    desktop.app = undefined;
    window.localStorage.clear();
    vi.resetAllMocks();
  });

  it("asks the desktop host to wipe native sqlite", async () => {
    desktop.wipeMailbox.mockResolvedValue(undefined);
    desktop.app = { wipeMailbox: desktop.wipeMailbox };
    await wipeLocalMailbox();
    expect(senderQueue.clear).toHaveBeenCalledTimes(1);
    expect(searchHistory.clear).toHaveBeenCalledTimes(1);
    expect(offlineCache.clear).toHaveBeenCalledTimes(1);
    expect(desktop.wipeMailbox).toHaveBeenCalledTimes(1);
    expect(opfs.wipe).not.toHaveBeenCalled();
  });

  it("closes the engine before removing its OPFS mailbox", async () => {
    const order: string[] = [];
    engine.close.mockImplementation(async () => {
      order.push("close");
    });
    opfs.wipe.mockImplementation(async () => {
      order.push("wipe");
      return true;
    });
    await wipeLocalMailbox();
    expect(order).toEqual(["close", "wipe"]);
    expect(offlineCache.clear).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing for the next engine once the wipe succeeds", async () => {
    opfs.wipe.mockResolvedValue(true);
    await wipeLocalMailbox();
    opfs.wipe.mockClear();

    await finishPendingLocalMailboxWipe();

    expect(opfs.wipe).not.toHaveBeenCalled();
  });

  it("has the next engine finish a wipe that could not complete", async () => {
    opfs.wipe.mockResolvedValue(false);
    await wipeLocalMailbox();
    opfs.wipe.mockResolvedValue(true);

    await finishPendingLocalMailboxWipe();
    await finishPendingLocalMailboxWipe();

    expect(opfs.wipe).toHaveBeenCalledTimes(2);
    // Finishing a wipe at engine start must not close the engine being opened.
    expect(engine.close).toHaveBeenCalledTimes(1);
  });

  it("has the next engine finish a wipe the page left before completing", async () => {
    engine.close.mockReturnValue(new Promise(() => {}));
    wipeLocalMailbox();
    opfs.wipe.mockResolvedValue(true);

    await finishPendingLocalMailboxWipe();

    expect(opfs.wipe).toHaveBeenCalledTimes(1);
  });
});
