import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuildReloader } from "@/utils/build-reload";

const OWN = "dpl_old";
const NEW = "dpl_new";

describe("createBuildReloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads a hidden tab as soon as the server names a newer build", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.noteServerBuild(NEW);
    await vi.runOnlyPendingTimersAsync();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the server names this page's own build", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.noteServerBuild(OWN);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("does nothing without a deployment id of its own", async () => {
    const tab = setup({ hidden: true, ownBuildId: undefined });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.broadcast).not.toHaveBeenCalled();
  });

  it("waits for a visible tab to be left alone before reloading", async () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(30_000);
    tab.reloader.noteActivity();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tab.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads while the user is typing", async () => {
    const tab = setup({ hidden: true, editing: true });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("waits out a hold, such as an open composer, then reloads on its release", async () => {
    const tab = setup({ hidden: true });
    const release = tab.reloader.hold();
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("waits while queued changes have not reached the server", async () => {
    const tab = setup({ hidden: true });
    let pending = 2;
    tab.reloader.hold(async () => pending === 0);
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    pending = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("treats a hold that fails as not safe", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.hold(() => {
      throw new Error("engine gone");
    });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("stands down when the server goes back to this page's build", async () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(30_000);
    tab.reloader.noteServerBuild(OWN);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("tells the other tabs once per build, but not what it heard from them", () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    tab.reloader.noteServerBuild(NEW);
    tab.reloader.noteServerBuild("dpl_peer", { fromPeer: true });
    expect(tab.broadcast).toHaveBeenCalledTimes(1);
    expect(tab.broadcast).toHaveBeenCalledWith(NEW);
  });

  it("never reloads when the tab cannot record its reloads", async () => {
    const tab = setup({ hidden: true, storage: null });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("does not loop when builds keep alternating: a cooldown, then a daily cap", async () => {
    const storage = memoryStorage();
    let reloads = 0;
    // Each reload is a fresh page in the same tab, with the same storage,
    // which gets whichever build answered and then hears the other one.
    const builds = ["dpl_a", "dpl_b"];
    for (let page = 0; page < 12; page++) {
      const own = builds[page % 2];
      const other = builds[(page + 1) % 2];
      const tab = setup({ hidden: true, storage, ownBuildId: own });
      tab.reload.mockImplementation(() => {
        reloads++;
      });
      tab.reloader.noteServerBuild(other);
      await vi.advanceTimersByTimeAsync(0);
      const reloaded = tab.reload.mock.calls.length > 0;
      tab.reloader.dispose();
      if (!reloaded) {
        // A blocked page keeps the build it has until its cooldown passes.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      }
    }
    expect(reloads).toBe(3);
  });

  it("lets a tab reload again once its reloads are a day old", async () => {
    const storage = memoryStorage();
    for (let page = 0; page < 3; page++) {
      const tab = setup({ hidden: true, storage });
      tab.reloader.noteServerBuild(`dpl_${page}`);
      await vi.advanceTimersByTimeAsync(0);
      tab.reloader.dispose();
      await vi.advanceTimersByTimeAsync(11 * 60_000);
    }
    const capped = setup({ hidden: true, storage });
    capped.reloader.noteServerBuild("dpl_later");
    await vi.advanceTimersByTimeAsync(0);
    expect(capped.reload).not.toHaveBeenCalled();
    capped.reloader.dispose();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    const nextDay = setup({ hidden: true, storage });
    nextDay.reloader.noteServerBuild("dpl_later");
    await vi.advanceTimersByTimeAsync(0);
    expect(nextDay.reload).toHaveBeenCalledTimes(1);
  });
});

function setup(options: {
  hidden: boolean;
  editing?: boolean;
  ownBuildId?: string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}) {
  const reload = vi.fn();
  const broadcast = vi.fn();
  const reloader = createBuildReloader({
    readOwnBuildId: () => ("ownBuildId" in options ? options.ownBuildId : OWN),
    storage: options.storage === undefined ? memoryStorage() : options.storage,
    reload,
    broadcast,
    isHidden: () => options.hidden,
    isEditingText: () => options.editing ?? false,
  });
  return { reloader, reload, broadcast };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
