import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  wipeLocalMailbox: vi.fn(),
  redirect: vi.fn(),
  toastLoading: vi.fn(),
  clearLastEmailAccount: vi.fn(),
}));

vi.mock("@/utils/auth-client", () => ({ signOut: mocks.signOut }));
vi.mock("@/utils/mail-engine/wipe-local-mailbox", () => ({
  wipeLocalMailbox: mocks.wipeLocalMailbox,
}));
vi.mock("@/utils/redirect", () => ({ redirectToSafeUrl: mocks.redirect }));
vi.mock("@/components/Toast", () => ({ toastLoading: mocks.toastLoading }));
vi.mock("@/utils/actions/email-account-cookie", () => ({
  clearLastEmailAccountAction: mocks.clearLastEmailAccount,
}));
vi.mock("@/utils/mail-engine/reply-drafts", () => ({
  clearLocalReplyDrafts: vi.fn(),
}));
vi.mock("@/utils/swr-persistence", () => ({
  clearPersistedSwrCache: vi.fn(),
}));

describe("logOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.signOut.mockResolvedValue({ data: { success: true } });
    mocks.wipeLocalMailbox.mockResolvedValue(undefined);
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

  it("still leaves when the sign-out request fails", async () => {
    mocks.signOut.mockRejectedValue(new Error("offline"));
    const logOut = await loadLogOut();

    await logOut();

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
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
