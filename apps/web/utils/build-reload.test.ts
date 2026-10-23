// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBuildReloader,
  isMailShellPath,
  pageHasActionToast,
  pageHasOpenDialog,
} from "@/utils/build-reload";

const OWN = "dpl_old";
const NEW = "dpl_new";
const HIDDEN_LONG_ENOUGH_MS = 5 * 60_000;

describe("createBuildReloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads a mail screen left hidden and untouched for five minutes", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(HIDDEN_LONG_ENOUGH_MS - 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads a visible tab by itself, and offers a reload instead", async () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.offerReload).toHaveBeenCalledTimes(1);

    tab.offerReload.mock.calls[0][0]();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("counts hidden time from the last hide, not from when the build changed", async () => {
    const tab = setup({ hidden: false });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    tab.state.hidden = true;
    tab.reloader.noteVisibility();
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(HIDDEN_LONG_ENOUGH_MS - 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("waits five minutes past the user's last input, even while hidden", async () => {
    const tab = setup({ hidden: true });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    tab.reloader.noteActivity();
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the desktop app", async () => {
    const tab = setup({ hidden: true, desktop: true });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    tab.reloader.noteNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.offerReload).not.toHaveBeenCalled();
    expect(tab.broadcast).not.toHaveBeenCalled();
  });

  it("does nothing without a deployment id of its own", async () => {
    const tab = setup({ hidden: true, ownBuildId: undefined });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.broadcast).not.toHaveBeenCalled();
  });

  it("does nothing while the server names this page's own build", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.noteServerBuild(OWN);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("loads the next in-app route in full, even while visible", async () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    tab.reloader.noteNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  describe("holds a hidden tab", () => {
    it.each([
      ["off a mail screen, such as settings", { mailShell: false }],
      ["while a dialog is open", { dialog: true }],
      ["while a toast offers an action, such as undo", { actionToast: true }],
      ["while the user is typing", { editing: true }],
    ] as const)("%s", async (_name, state) => {
      const tab = setup({ hidden: true, ...state });
      tab.reloader.noteServerBuild(NEW);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(tab.reload).not.toHaveBeenCalled();
    });

    it.each([
      "an open composer",
      "a page guarding unsaved work",
      "a streaming chat reply",
    ])("while %s holds it, until released", async () => {
      const tab = setup({ hidden: true });
      const release = tab.reloader.hold();
      tab.reloader.noteServerBuild(NEW);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(tab.reload).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(tab.reload).toHaveBeenCalledTimes(1);
    });

    it("while queued changes have not reached the server", async () => {
      const tab = setup({ hidden: true });
      let pending = 2;
      tab.reloader.hold(async () => pending === 0);
      tab.reloader.noteServerBuild(NEW);
      await vi.advanceTimersByTimeAsync(HIDDEN_LONG_ENOUGH_MS + 60_000);
      expect(tab.reload).not.toHaveBeenCalled();
      pending = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tab.reload).toHaveBeenCalledTimes(1);
    });

    it("when a hold throws", async () => {
      const tab = setup({ hidden: true });
      tab.reloader.hold(() => {
        throw new Error("engine gone");
      });
      tab.reloader.noteServerBuild(NEW);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(tab.reload).not.toHaveBeenCalled();
    });

    it("when a hold never answers, and keeps checking after it times out", async () => {
      const tab = setup({ hidden: true });
      let wedged = true;
      tab.reloader.hold(() => (wedged ? new Promise<boolean>(() => {}) : true));
      tab.reloader.noteServerBuild(NEW);
      await vi.advanceTimersByTimeAsync(HIDDEN_LONG_ENOUGH_MS + 60_000);
      expect(tab.reload).not.toHaveBeenCalled();
      wedged = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tab.reload).toHaveBeenCalledTimes(1);
    });

    it("on navigation too, while a composer is open", async () => {
      const tab = setup({ hidden: false });
      tab.reloader.hold();
      tab.reloader.noteServerBuild(NEW);
      tab.reloader.noteNavigation();
      await vi.advanceTimersByTimeAsync(0);
      expect(tab.reload).not.toHaveBeenCalled();
    });
  });

  it("stands down when the server goes back to this page's build", async () => {
    const tab = setup({ hidden: true });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60_000);
    tab.reloader.noteServerBuild(OWN);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.withdrawOffer).toHaveBeenCalled();
  });

  it("after a reload that came back on the same build, waits for a different one", async () => {
    const storage = memoryStorage();
    const first = setup({ hidden: true, storage });
    first.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(HIDDEN_LONG_ENOUGH_MS);
    expect(first.reload).toHaveBeenCalledTimes(1);
    first.reloader.dispose();

    // The saved shell answered the reload: same build as before.
    const again = setup({ hidden: true, storage });
    again.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    again.reloader.noteNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(again.reload).not.toHaveBeenCalled();
    expect(again.offerReload).not.toHaveBeenCalled();

    again.reloader.noteServerBuild("dpl_newer");
    again.reloader.noteNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(again.reload).toHaveBeenCalledTimes(1);
  });

  it("tells the other tabs once per build, but not what it heard from them", () => {
    const tab = setup({ hidden: false });
    tab.reloader.noteServerBuild(NEW);
    tab.reloader.noteServerBuild(NEW);
    tab.reloader.noteServerBuild("dpl_peer", { fromPeer: true });
    expect(tab.broadcast).toHaveBeenCalledTimes(1);
    expect(tab.broadcast).toHaveBeenCalledWith(NEW);
  });

  it("never reloads by itself when the tab cannot record its reloads", async () => {
    const tab = setup({ hidden: true, storage: null });
    tab.reloader.noteServerBuild(NEW);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    tab.reloader.noteNavigation();
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("does not loop when builds keep alternating: a cooldown, then a daily cap", async () => {
    const storage = memoryStorage();
    let reloads = 0;
    const other = { dpl_a: "dpl_b", dpl_b: "dpl_a" } as const;
    let own: keyof typeof other = "dpl_a";
    for (let page = 0; page < 12; page++) {
      // Each page hears the build it is not on; a reload lands on that one.
      const tab = setup({ hidden: false, storage, ownBuildId: own });
      tab.reloader.noteServerBuild(other[own]);
      tab.reloader.noteNavigation();
      await vi.advanceTimersByTimeAsync(0);
      if (tab.reload.mock.calls.length > 0) {
        reloads++;
        own = other[own];
      }
      tab.reloader.dispose();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    expect(reloads).toBe(3);
  });
});

describe("page checks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("treats only the mail list, the reader and Today as mail screens", () => {
    expect(isMailShellPath("/mail/u/0")).toBe(true);
    expect(isMailShellPath("/mail/u/1/sent/thread-1")).toBe(true);
    expect(isMailShellPath("/acc-1/home")).toBe(true);
    expect(isMailShellPath("/acc-1/settings")).toBe(false);
    expect(isMailShellPath("/acc-1/automation")).toBe(false);
  });

  it("sees an open dialog, but not a closed one", () => {
    document.body.innerHTML = '<div role="dialog" data-state="closed"></div>';
    expect(pageHasOpenDialog(document)).toBe(false);
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    expect(pageHasOpenDialog(document)).toBe(true);
    document.body.innerHTML = '<div aria-modal="true"></div>';
    expect(pageHasOpenDialog(document)).toBe(true);
  });

  it("sees a toast with an action button, but not a plain one", () => {
    document.body.innerHTML = "<li data-sonner-toast><div>Archived</div></li>";
    expect(pageHasActionToast(document)).toBe(false);
    document.body.innerHTML =
      "<li data-sonner-toast><button data-button>Undo</button></li>";
    expect(pageHasActionToast(document)).toBe(true);
  });
});

function setup(options: {
  hidden: boolean;
  desktop?: boolean;
  mailShell?: boolean;
  dialog?: boolean;
  actionToast?: boolean;
  editing?: boolean;
  ownBuildId?: string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}) {
  const state = { hidden: options.hidden };
  const reload = vi.fn();
  const broadcast = vi.fn();
  const offerReload = vi.fn<(onReload: () => void) => void>();
  const withdrawOffer = vi.fn();
  const reloader = createBuildReloader({
    readOwnBuildId: () => ("ownBuildId" in options ? options.ownBuildId : OWN),
    isDesktopApp: () => options.desktop ?? false,
    storage: options.storage === undefined ? memoryStorage() : options.storage,
    reload,
    broadcast,
    isHidden: () => state.hidden,
    isMailShellRoute: () => options.mailShell ?? true,
    isEditingText: () => options.editing ?? false,
    hasOpenDialog: () => options.dialog ?? false,
    hasActionToast: () => options.actionToast ?? false,
    offerReload,
    withdrawOffer,
  });
  return { reloader, reload, broadcast, offerReload, withdrawOffer, state };
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
