/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { closeActiveMailEngine } from "./active-client";
import { MailCoverageGate, MailEngineRuntime } from "./MailEngineHost";
import { MAIL_ENGINE_TAB_CHANNEL } from "./tab-channel";

const runtime = vi.hoisted(() => ({
  account: {
    accountIds: ["account-a", "account-b"],
    emailAccountId: "account-a",
    provider: "google",
    isLoading: false,
  },
  engines: [] as Array<{
    start: { accountId: string };
    ensureAccount: ReturnType<typeof vi.fn>;
    requestSync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  emailAccounts: [] as unknown[],
  earlyOwnerLock: null as (() => void) | null | Promise<(() => void) | null>,
  order: [] as string[],
  firstMailList: new Set<() => void>(),
}));

vi.mock("@/utils/mail-engine/first-mail-list", () => ({
  afterFirstMailList: (callback: () => void) => {
    runtime.firstMailList.add(callback);
    return () => runtime.firstMailList.delete(callback);
  },
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => runtime.account,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/mail/u/0/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ data: { emailAccounts: runtime.emailAccounts } }),
}));
vi.mock("@/utils/fetch-email-accounts", () => ({
  fetchEmailAccounts: async () => ({ emailAccounts: runtime.emailAccounts }),
}));
vi.mock("@/utils/mail-engine/follow-mailbox-changes", () => ({
  followMailboxChanges: () => () => undefined,
  getFollowedAccountIds: (accountId: string) => [accountId],
}));
vi.mock("@/utils/mail-engine/poll-mail-versions", () => ({
  pollMailVersions: () => () => undefined,
  getPolledAccountIds: (accountId: string) => [accountId],
}));
vi.mock("@/utils/mail-engine/create-browser-engine", () => ({
  prewarmMailEngineWorker: () => undefined,
  releasePrewarmedMailEngineWorker: () => {
    runtime.order.push("release worker");
  },
  claimEarlyMailEngineOwnerLock: () => {
    const release = runtime.earlyOwnerLock;
    runtime.earlyOwnerLock = null;
    return release;
  },
  createBrowserMailEngine: async (start: { accountId: string }) => {
    runtime.order.push("create");
    const engine = {
      start,
      ensureAccount: vi.fn(async () => undefined),
      requestSync: vi.fn(async () => ({ status: "scheduled" })),
      retainAccounts: vi.fn(async () => undefined),
      // Every account reads as synced, so background registration moves on.
      observeMailbox: ({ accountIds }: { accountIds: string[] }) => ({
        getSnapshot: () => ({
          status: "ready",
          data: {
            coverage: accountIds.map((accountId) => ({
              accountId,
              lastCompletedSyncAtMs: 1,
            })),
          },
        }),
        subscribe: () => () => undefined,
        close: () => undefined,
      }),
      close: vi.fn(async () => undefined),
    };
    runtime.engines.push(engine);
    return engine;
  },
}));

vi.mock("@/utils/actions/email-account-cookie", () => ({
  setLastEmailAccountAction: vi.fn(),
}));
vi.mock("@/utils/actions/web-push", () => ({
  saveWebPushSubscriptionAction: vi.fn(),
  deleteWebPushSubscriptionAction: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal("navigator", {
    ...navigator,
    storage: { getDirectory: async () => ({}) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  runtime.engines.length = 0;
  runtime.emailAccounts = [];
  runtime.earlyOwnerLock = null;
  runtime.order.length = 0;
  runtime.firstMailList.clear();
  runtime.account = {
    ...runtime.account,
    emailAccountId: "account-a",
    provider: "google",
    isLoading: false,
  };
});

describe("MailEngineRuntime", () => {
  it("keeps one engine across an account switch and syncs the account switched to", async () => {
    const seen: unknown[] = [];
    const { rerender } = await renderRuntime(seen);
    await vi.waitFor(() => expect(runtime.engines).toHaveLength(1));
    const [engine] = runtime.engines;
    await vi.waitFor(() => expect(seen.at(-1)).toBe(engine));
    expect(engine?.start.accountId).toBe("account-a");

    runtime.account = {
      ...runtime.account,
      emailAccountId: "account-b",
      provider: "microsoft",
    };
    await act(async () => {
      rerender(<Runtime seen={seen} />);
    });

    await vi.waitFor(() =>
      expect(engine?.requestSync).toHaveBeenCalledWith(["account-b"]),
    );
    expect(engine?.ensureAccount).toHaveBeenCalledWith({
      accountId: "account-b",
      provider: "microsoft",
    });
    expect(runtime.engines).toHaveLength(1);
    expect(engine?.close).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe(engine);
  });

  it("starts the engine under the owner lock the page took while it hydrated, until it unmounts", async () => {
    const request = vi.fn();
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { getDirectory: async () => ({}) },
      locks: { request },
    });
    const releaseEarlyLock = vi.fn();
    runtime.earlyOwnerLock = releaseEarlyLock;
    const seen: unknown[] = [];
    const { unmount } = await renderRuntime(seen);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(runtime.engines[0]));

    // The lock is already this page's; asking again would wait on itself.
    expect(request).not.toHaveBeenCalled();
    expect(releaseEarlyLock).not.toHaveBeenCalled();

    unmount();
    await vi.waitFor(() => expect(releaseEarlyLock).toHaveBeenCalledTimes(1));
    expect(runtime.engines[0]?.close).toHaveBeenCalled();
  });

  it("lets go of the early worker before its lock when the page leaves while the claim is pending", async () => {
    let answerClaim: (release: () => void) => void = () => undefined;
    runtime.earlyOwnerLock = new Promise((resolve) => {
      answerClaim = resolve;
    });
    const { unmount } = await renderRuntime([]);

    unmount();
    await act(async () => {
      answerClaim(() => runtime.order.push("release lock"));
    });

    // The early worker may hold an open mailbox, which must not outlive the
    // lock that keeps every other tab off its files.
    await vi.waitFor(() =>
      expect(runtime.order).toEqual(["release worker", "release lock"]),
    );
    expect(runtime.engines).toHaveLength(0);
  });

  it("closes the engine and lets go of the early lock on sign-out", async () => {
    const releaseEarlyLock = vi.fn();
    runtime.earlyOwnerLock = releaseEarlyLock;
    const seen: unknown[] = [];
    await renderRuntime(seen);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(runtime.engines[0]));

    await act(async () => {
      await closeActiveMailEngine();
    });

    expect(runtime.order).toContain("release worker");
    expect(runtime.engines[0]?.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(releaseEarlyLock).toHaveBeenCalledTimes(1));
  });

  it("lets go of the early worker when another tab owns the engine", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { getDirectory: async () => ({}) },
      // The other tab holds the owner lock.
      locks: { request: () => new Promise(() => undefined) },
    });
    const seen: unknown[] = [];
    await renderRuntime(seen);
    const otherTab = new BroadcastChannel(MAIL_ENGINE_TAB_CHANNEL);

    otherTab.postMessage({ type: "owner", accountId: "account-a" });

    await vi.waitFor(() => expect(runtime.order).toEqual(["release worker"]));
    await vi.waitFor(() => expect(seen.at(-1)).toBeTruthy());
    expect(runtime.engines).toHaveLength(0);
    otherTab.close();
  });

  it("lets go of the early worker on a page that will not start the engine", async () => {
    runtime.account = { ...runtime.account, emailAccountId: "" };

    await renderRuntime([]);

    expect(runtime.order).toEqual(["release worker"]);
  });

  it("lets go of the early worker once accounts load without one to start on", async () => {
    runtime.account = { ...runtime.account, provider: "", isLoading: true };
    const { rerender } = await renderRuntime([]);
    expect(runtime.order).toEqual([]);

    runtime.account = {
      ...runtime.account,
      emailAccountId: "",
      isLoading: false,
    };
    await act(async () => {
      rerender(<Runtime seen={[]} />);
    });

    expect(runtime.order).toEqual(["release worker"]);
  });

  it("keeps the early worker while the accounts are still loading", async () => {
    runtime.account = { ...runtime.account, provider: "", isLoading: true };
    const { rerender } = await renderRuntime([]);
    expect(runtime.order).toEqual([]);

    runtime.account = {
      ...runtime.account,
      provider: "google",
      isLoading: false,
    };
    await act(async () => {
      rerender(<Runtime seen={[]} />);
    });

    await vi.waitFor(() => expect(runtime.order).toEqual(["create"]));
  });

  it("registers every other connected account only after the first mail list", async () => {
    runtime.emailAccounts = [
      connectedAccount("account-a", "google"),
      connectedAccount("account-b", "microsoft", {
        includeInAllAccounts: false,
      }),
      connectedAccount("account-c", "google"),
    ];
    await renderRuntime([]);
    await vi.waitFor(() => expect(runtime.engines).toHaveLength(1));
    const [engine] = runtime.engines;
    await vi.waitFor(() => expect(runtime.firstMailList.size).toBe(1));

    // Nothing competes with the viewed account's first list.
    expect(engine?.ensureAccount).not.toHaveBeenCalled();
    expect(engine?.requestSync).not.toHaveBeenCalled();

    await act(async () => {
      for (const callback of runtime.firstMailList) callback();
    });
    await vi.waitFor(() =>
      expect(engine?.ensureAccount).toHaveBeenCalledWith({
        accountId: "account-c",
        provider: "google",
      }),
    );
    expect(engine?.ensureAccount).toHaveBeenCalledWith({
      accountId: "account-b",
      provider: "microsoft",
    });
    // The account it started on was registered by the start itself.
    expect(engine?.ensureAccount).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-a" }),
    );
    await vi.waitFor(() =>
      expect(engine?.requestSync).toHaveBeenCalledWith(["account-b"]),
    );
  });
});

function Runtime({ seen }: { seen: unknown[] }) {
  return (
    <MailEngineRuntime>
      <Probe seen={seen} />
    </MailEngineRuntime>
  );
}

function Probe({ seen }: { seen: unknown[] }) {
  seen.push(useOptionalMailClient());
  return null;
}

async function renderRuntime(seen: unknown[]) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(<Runtime seen={seen} />);
  });
  return result as ReturnType<typeof render>;
}

function connectedAccount(
  id: string,
  provider: string,
  options: { includeInAllAccounts?: boolean } = {},
) {
  return {
    id,
    includeInAllAccounts: options.includeInAllAccounts ?? true,
    account: { provider, disconnectedAt: null },
  };
}

describe("MailCoverageGate", () => {
  it("holds a screen back until the mail engine is ready", async () => {
    await act(async () => {
      render(
        <MailCoverageGate fallback={<p>frame</p>}>
          <p>mail screen</p>
        </MailCoverageGate>,
      );
    });

    expect(screen.getByText("frame")).toBeTruthy();
    expect(screen.queryByText("mail screen")).toBeNull();
  });

  it("shows the mail screen while the engine starts when asked, so it never remounts", async () => {
    await act(async () => {
      render(
        <MailCoverageGate fallback={<p>frame</p>} showChildrenWhileStarting>
          <p>mail screen</p>
        </MailCoverageGate>,
      );
    });

    expect(screen.getByText("mail screen")).toBeTruthy();
    expect(screen.queryByText("frame")).toBeNull();
  });
});
