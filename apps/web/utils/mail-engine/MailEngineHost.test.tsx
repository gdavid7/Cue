/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { MailCoverageGate, MailEngineRuntime } from "./MailEngineHost";

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
  createBrowserMailEngine: async (start: { accountId: string }) => {
    const engine = {
      start,
      ensureAccount: vi.fn(async () => undefined),
      requestSync: vi.fn(async () => ({ status: "scheduled" })),
      retainAccounts: vi.fn(async () => undefined),
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
  runtime.account = { ...runtime.account, emailAccountId: "account-a" };
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

  it("registers every connected account when the engine starts, so each can sync and notify", async () => {
    runtime.emailAccounts = [
      connectedAccount("account-a", "google"),
      connectedAccount("account-b", "microsoft", {
        includeInAllAccounts: false,
      }),
    ];
    await renderRuntime([]);
    await vi.waitFor(() => expect(runtime.engines).toHaveLength(1));
    const [engine] = runtime.engines;

    await vi.waitFor(() =>
      expect(engine?.ensureAccount).toHaveBeenCalledWith({
        accountId: "account-b",
        provider: "microsoft",
      }),
    );
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
