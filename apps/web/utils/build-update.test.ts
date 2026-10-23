import { describe, expect, it, vi } from "vitest";
import { createBuildUpdateNotifier } from "@/utils/build-update";

const OWN = "dpl_old";
const NEW = "dpl_new";

describe("createBuildUpdateNotifier", () => {
  it("offers a reload when the server names a newer build, and reloads only on the user's click", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    expect(tab.offerReload).toHaveBeenCalledTimes(1);
    expect(tab.reload).not.toHaveBeenCalled();

    tab.clickReload();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("offers each newer build once per tab", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    tab.notifier.noteServerBuild(NEW);
    tab.notifier.noteServerBuild(NEW, { fromPeer: true });
    expect(tab.offerReload).toHaveBeenCalledTimes(1);

    tab.notifier.noteServerBuild("dpl_newer");
    expect(tab.offerReload).toHaveBeenCalledTimes(2);
  });

  it("does not raise a dismissed offer again for that build", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    tab.dismiss();
    tab.notifier.noteServerBuild(NEW);
    expect(tab.offerReload).toHaveBeenCalledTimes(1);
  });

  // The page's leave prompt can cancel the reload; the offer stays usable.
  it("can reload again after a cancelled reload", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    tab.clickReload();
    tab.clickReload();
    expect(tab.reload).toHaveBeenCalledTimes(2);
  });

  // A reload the service worker answered from its saved shell lands back on
  // the old build: the new page offers again, and does nothing by itself.
  it("offers again on a page that reloaded back onto the old build", () => {
    const before = setup();
    before.notifier.noteServerBuild(NEW);
    before.clickReload();

    const after = setup();
    after.notifier.noteServerBuild(NEW);
    expect(after.offerReload).toHaveBeenCalledTimes(1);
    expect(after.reload).not.toHaveBeenCalled();
  });

  it("offers nothing while the server names this page's own build", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(OWN);
    expect(tab.offerReload).not.toHaveBeenCalled();
  });

  it("withdraws the offer when the server goes back to this page's build", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    tab.notifier.noteServerBuild(OWN);
    expect(tab.withdrawOffer).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the desktop app", () => {
    const tab = setup({ desktop: true });
    tab.notifier.noteServerBuild(NEW);
    expect(tab.offerReload).not.toHaveBeenCalled();
    expect(tab.broadcast).not.toHaveBeenCalled();
  });

  it("does nothing without a deployment id of its own", () => {
    const tab = setup({ ownBuildId: undefined });
    tab.notifier.noteServerBuild(NEW);
    expect(tab.offerReload).not.toHaveBeenCalled();
    expect(tab.broadcast).not.toHaveBeenCalled();
  });

  it("tells the other tabs once per build, but not what it heard from them", () => {
    const tab = setup();
    tab.notifier.noteServerBuild(NEW);
    tab.notifier.noteServerBuild(NEW);
    tab.notifier.noteServerBuild("dpl_peer", { fromPeer: true });
    expect(tab.broadcast).toHaveBeenCalledTimes(1);
    expect(tab.broadcast).toHaveBeenCalledWith(NEW);
    expect(tab.offerReload).toHaveBeenCalledTimes(2);
  });
});

function setup(options: { desktop?: boolean; ownBuildId?: string } = {}) {
  const reload = vi.fn();
  const broadcast = vi.fn();
  const offerReload =
    vi.fn<(onReload: () => void, onDismiss: () => void) => void>();
  const withdrawOffer = vi.fn();
  const notifier = createBuildUpdateNotifier({
    readOwnBuildId: () => ("ownBuildId" in options ? options.ownBuildId : OWN),
    isDesktopApp: () => options.desktop ?? false,
    reload,
    offerReload,
    withdrawOffer,
    broadcast,
  });
  const lastOffer = () => {
    const call = offerReload.mock.calls.at(-1);
    if (!call) throw new Error("no offer");
    return call;
  };
  return {
    notifier,
    reload,
    broadcast,
    offerReload,
    withdrawOffer,
    clickReload: () => lastOffer()[0](),
    dismiss: () => lastOffer()[1](),
  };
}
