/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  wipeLocalMailbox: vi.fn(),
  redirect: vi.fn(),
  toastLoading: vi.fn(),
  toastDismiss: vi.fn(),
  clearLastEmailAccount: vi.fn(),
  swrFetcher: vi.fn(),
  clearBrowserCaches: vi.fn(),
  clearInboxInsightRequests: vi.fn(),
  syncWebPush: vi.fn(),
}));

vi.mock("@/utils/auth-client", () => ({ signOut: mocks.signOut }));
vi.mock("@/utils/mail-engine/wipe-local-mailbox", () => ({
  wipeLocalMailbox: mocks.wipeLocalMailbox,
}));
vi.mock("@/utils/redirect", () => ({ redirectToSafeUrl: mocks.redirect }));
vi.mock("@/components/Toast", () => ({
  toastLoading: mocks.toastLoading,
  toastDismiss: mocks.toastDismiss,
}));
vi.mock("@/utils/actions/email-account-cookie", () => ({
  clearLastEmailAccountAction: mocks.clearLastEmailAccount,
}));
vi.mock("@/utils/mail-engine/reply-drafts", () => ({
  clearLocalReplyDrafts: vi.fn(),
}));
vi.mock("@/providers/swr-fetcher", () => ({ swrFetcher: mocks.swrFetcher }));
vi.mock("@/utils/swr-persistence", () => ({
  clearPersistedSwrCache: vi.fn(),
}));
vi.mock("@/hooks/useInboxInsights", () => ({
  clearInboxInsightRequests: mocks.clearInboxInsightRequests,
}));
vi.mock("@/utils/browser-cache", () => ({
  clearBrowserCaches: mocks.clearBrowserCaches,
}));
vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => true,
  syncWebPushSubscription: mocks.syncWebPush,
}));

describe("logOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.signOut.mockResolvedValue({ data: { success: true } });
    mocks.wipeLocalMailbox.mockResolvedValue(undefined);
    mocks.clearLastEmailAccount.mockResolvedValue(undefined);
    mocks.syncWebPush.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("acknowledges the click before the server answers", async () => {
    const session = deferred<{ data: { success: boolean } }>();
    mocks.signOut.mockReturnValue(session.promise);
    const logOut = await loadLogOut();

    const done = logOut();

    expect(mocks.toastLoading).toHaveBeenCalledWith("Signing out…");
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.wipeLocalMailbox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.redirect).not.toHaveBeenCalled();

    session.resolve({ data: { success: true } });
    await done;
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("stops the page's API traffic as soon as sign-out starts", async () => {
    const logOut = await loadLogOut();
    const { isSigningOut } = await import("./signing-out");

    const done = logOut();

    expect(isSigningOut()).toBe(true);
    await done;
  });

  it("signs out once however many times it is clicked", async () => {
    const logOut = await loadLogOut();

    await Promise.all([logOut(), logOut(), logOut()]);

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.wipeLocalMailbox).toHaveBeenCalledTimes(1);
    expect(mocks.toastLoading).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("leaves without waiting for a local wipe that never finishes", async () => {
    mocks.wipeLocalMailbox.mockReturnValue(new Promise(() => {}));
    const logOut = await loadLogOut();

    const done = logOut();
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("waits for the last-account cookie to clear before leaving, even after the session has ended", async () => {
    const cleared = deferred<undefined>();
    mocks.clearLastEmailAccount.mockReturnValue(cleared.promise);
    const logOut = await loadLogOut();

    const done = logOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).not.toHaveBeenCalled();

    cleared.resolve(undefined);
    await done;
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("leaves without waiting for a cookie clear that never answers", async () => {
    mocks.clearLastEmailAccount.mockReturnValue(new Promise(() => {}));
    const logOut = await loadLogOut();

    const done = logOut();
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("forgets the briefs, replies and insights kept in this browser", async () => {
    const logOut = await loadLogOut();

    await logOut();

    expect(mocks.clearBrowserCaches).toHaveBeenCalledTimes(1);
    // And the insights this page was given, kept beside them in memory.
    expect(mocks.clearInboxInsightRequests).toHaveBeenCalledTimes(1);
  });

  it("stops push notifications to this browser before leaving", async () => {
    const logOut = await loadLogOut();

    await logOut();

    expect(mocks.syncWebPush).toHaveBeenCalledExactlyOnceWith("off");
  });

  it("leaves without waiting for a push unsubscribe that never finishes", async () => {
    mocks.syncWebPush.mockReturnValue(new Promise(() => {}));
    const logOut = await loadLogOut();

    const done = logOut();
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("still leaves when the sign-out request fails", async () => {
    mocks.signOut.mockRejectedValue(new Error("offline"));
    const logOut = await loadLogOut();

    await logOut();

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
  it("still leaves when a cleanup step throws, and lets a second click try again", async () => {
    mocks.clearBrowserCaches.mockImplementationOnce(() => {
      throw new Error("storage blocked");
    });
    const logOut = await loadLogOut();
    const { isSigningOut } = await import("./signing-out");

    await expect(logOut()).rejects.toThrow("storage blocked");

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isSigningOut()).toBe(false);
    await logOut();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("resumes the page when leaving is cancelled", async () => {
    const logOut = await loadLogOut();
    const { isSigningOut } = await import("./signing-out");

    await logOut();
    expect(isSigningOut()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(isSigningOut()).toBe(false);
    await logOut();
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
  });

  it("dismisses the signing-out toast when leaving is cancelled, not when the page leaves", async () => {
    mocks.toastLoading.mockReturnValue("toast-1");
    const logOut = await loadLogOut();

    await logOut();
    expect(mocks.toastDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.toastDismiss).toHaveBeenCalledExactlyOnceWith("toast-1");
  });

  it("stays quiet when the page really leaves", async () => {
    const logOut = await loadLogOut();
    const { isSigningOut } = await import("./signing-out");

    await logOut();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(isSigningOut()).toBe(true);
  });
});

async function loadLogOut() {
  vi.resetModules();
  const { logOut } = await import("@/utils/user");
  return logOut;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
