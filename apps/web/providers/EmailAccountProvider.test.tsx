// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailAccountProvider,
  EmailAccountPreviewProvider,
  useAccount,
} from "./EmailAccountProvider";
import {
  fetchEmailAccounts,
  resetEmailAccountsInflight,
} from "@/utils/fetch-email-accounts";

const navigation = vi.hoisted(() => ({
  emailAccountId: undefined as string | undefined,
  accountIndex: undefined as string | undefined,
  replace: vi.fn(),
}));
const cookie = vi.hoisted(() => ({ setLastAccount: vi.fn() }));
const toast = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("@/components/Toast", () => ({ toastInfo: toast.info }));

vi.mock("next/navigation", () => ({
  useParams: () => ({
    emailAccountId: navigation.emailAccountId,
    accountIndex: navigation.accountIndex,
  }),
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/utils/actions/email-account-cookie", () => ({
  setLastEmailAccountAction: cookie.setLastAccount,
}));

describe("EmailAccountProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmailAccountsInflight();
    navigation.emailAccountId = undefined;
    navigation.accountIndex = undefined;
    cookie.setLastAccount.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    resetEmailAccountsInflight();
    vi.unstubAllGlobals();
  });

  it("supports account-free previews without requesting user accounts", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <EmailAccountPreviewProvider>
        <AccountState />
      </EmailAccountPreviewProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("ready without an account")).toBeTruthy();
  });

  it("resolves /mail/u/{n} to the user's nth account before accounts load", () => {
    navigation.accountIndex = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <EmailAccountProvider accounts={SERVER_ACCOUNTS}>
        <AccountState />
      </EmailAccountProvider>,
    );

    expect(screen.getByTestId("account-id").textContent).toBe("account-2");
    // The mail engine starts from this, so it must not wait on the fetch.
    expect(screen.getByTestId("provider").textContent).toBe("microsoft");
    // The server's list also names the address, so the list says "me" from
    // the first paint rather than the user's own address.
    expect(screen.getByTestId("user-email").textContent).toBe(
      "two@example.com",
    );
    // A mailbox rebuild restores carried work only for these owned accounts,
    // so the engine may start early only with the complete list.
    expect(screen.getByTestId("account-ids").textContent).toBe(
      "account-1,account-2",
    );
  });

  it("leaves the provider unknown until accounts load without a server list", () => {
    navigation.emailAccountId = "account-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    // The mail engine waits for a provider, and with it the owned accounts.
    expect(screen.getByTestId("provider").textContent).toBe("");
    expect(screen.getByTestId("account-ids").textContent).toBe("");
  });

  it("remembers the account a /mail/u/{n} address opened", async () => {
    navigation.accountIndex = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider accounts={SERVER_ACCOUNTS}>
        <AccountState />
      </EmailAccountProvider>,
    );

    await waitFor(() =>
      expect(cookie.setLastAccount).toHaveBeenCalledWith({
        emailAccountId: "account-2",
      }),
    );
    expect(screen.getByTestId("account-id").textContent).toBe("account-2");
  });

  it("does not rewrite the last-account cookie when the route already matches", async () => {
    navigation.emailAccountId = "account-1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await screen.findByText("ready with an account");
    expect(cookie.setLastAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId("account-id").textContent).toBe("account-1");
  });

  it("updates the last-account cookie for a different route account", async () => {
    navigation.emailAccountId = "account-2";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await waitFor(() =>
      expect(cookie.setLastAccount).toHaveBeenCalledWith({
        emailAccountId: "account-2",
      }),
    );
  });

  it("does not rewrite the last-account cookie for a deleted route account", async () => {
    navigation.emailAccountId = "deleted-account";
    window.history.replaceState(null, "", "/deleted-account/mail");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await screen.findByText("ready with an account");
    expect(cookie.setLastAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId("account-id").textContent).toBe("account-1");
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/account-1/mail"),
    );
  });

  it("does not replace an owned account route", async () => {
    navigation.emailAccountId = "account-1";
    window.history.replaceState(null, "", "/account-1/mail");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await screen.findByText("ready with an account");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("replaces a deleted account route after the account list refreshes", async () => {
    navigation.emailAccountId = "account-2";
    window.history.replaceState(null, "", "/account-2/mail");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => accountResponse("account-2"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            emailAccounts: [accountResponse("account-1").emailAccounts[0]],
            lastEmailAccountId: null,
          }),
        }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-2"),
    );
    expect(navigation.replace).not.toHaveBeenCalled();

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-1"),
    );
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/account-1/mail"),
    );
  });

  it("stays on the open account when an earlier account is removed", async () => {
    navigation.accountIndex = "1";
    window.history.replaceState(
      null,
      "",
      "/mail/u/1/sent/thread-9?ref=bookmark",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(threeAccountsResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            emailAccounts: threeAccountsList().slice(1),
            lastEmailAccountId: "account-2",
          }),
        }),
    );

    render(
      <EmailAccountProvider accounts={THREE_SERVER_ACCOUNTS}>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-2,account-3",
      ),
    );
    expect(screen.getByTestId("account-id").textContent).toBe("account-2");

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-2,account-3",
      ),
    );
    expect(screen.getByTestId("account-id").textContent).toBe("account-2");
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/mail/u/0/sent/thread-9?ref=bookmark",
      ),
    );
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("leaves a removed account's page with a notice instead of showing the next account", async () => {
    navigation.accountIndex = "1";
    window.history.replaceState(null, "", "/mail/u/1");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(threeAccountsResponse())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            emailAccounts: [threeAccountsList()[0], threeAccountsList()[2]],
            lastEmailAccountId: null,
          }),
        }),
    );

    render(
      <EmailAccountProvider accounts={THREE_SERVER_ACCOUNTS}>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-2,account-3",
      ),
    );

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-3",
      ),
    );
    expect(screen.getByTestId("account-id").textContent).not.toBe("account-3");
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/mail/u/0/inbox"),
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("moves an open All Inboxes thread's account when only an account before it is removed", async () => {
    navigation.accountIndex = "0";
    window.history.replaceState(
      null,
      "",
      "/mail/u/0/all-inboxes/inbox/thread-c?account=2",
    );
    const fourAccounts = ["account-1", "account-2", "account-3", "account-4"];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(listResponse(fourAccounts))
        .mockResolvedValueOnce(
          listResponse(fourAccounts.filter((id) => id !== "account-2")),
        ),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        fourAccounts.join(","),
      ),
    );

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/mail/u/0/all-inboxes/inbox/thread-c?account=1",
      ),
    );
    expect(screen.getByTestId("account-id").textContent).toBe("account-1");
  });

  it("never shows the account that moves into the open position while the address is rewritten", async () => {
    navigation.accountIndex = "2";
    window.history.replaceState(null, "", "/mail/u/2/inbox");
    const fourAccounts = ["account-1", "account-2", "account-3", "account-4"];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(listResponse(fourAccounts))
        .mockResolvedValueOnce(
          listResponse(fourAccounts.filter((id) => id !== "account-2")),
        ),
    );
    const shown: string[] = [];
    function RecordAccount() {
      shown.push(useAccount().emailAccountId);
      return null;
    }

    render(
      <EmailAccountProvider>
        <RecordAccount />
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-3"),
    );

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/mail/u/1/inbox"),
    );
    // The router mock leaves the old position in place, as a slow router does.
    expect(screen.getByTestId("account-id").textContent).toBe("account-3");
    expect(shown).not.toContain("account-4");
  });

  it("reindexes against the address's own list when a second removal lands before the router moves", async () => {
    navigation.accountIndex = "3";
    window.history.replaceState(
      null,
      "",
      "/mail/u/3/all-inboxes/inbox/thread-c?account=2",
    );
    const fourAccounts = ["account-1", "account-2", "account-3", "account-4"];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(listResponse(fourAccounts))
        .mockResolvedValueOnce(listResponse(fourAccounts.slice(1)))
        .mockResolvedValueOnce(listResponse(fourAccounts.slice(2))),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        fourAccounts.join(","),
      ),
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        "/mail/u/2/all-inboxes/inbox/thread-c?account=1",
      ),
    );
    // The router has not moved yet: the address still has u/3 and account=2.
    await fetchEmailAccounts();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        "/mail/u/1/all-inboxes/inbox/thread-c?account=0",
      ),
    );
    expect(screen.getByTestId("account-id").textContent).toBe("account-4");
  });

  it("drops a removed account's chat from the address it rewrites", async () => {
    navigation.accountIndex = "2";
    window.history.replaceState(
      null,
      "",
      "/mail/u/2/inbox?chatId=chat-b&chatAccountId=account-2",
    );
    const threeAccounts = ["account-1", "account-2", "account-3"];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(listResponse(threeAccounts))
        .mockResolvedValueOnce(
          listResponse(threeAccounts.filter((id) => id !== "account-2")),
        ),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        threeAccounts.join(","),
      ),
    );

    await fetchEmailAccounts();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/mail/u/1/inbox"),
    );
  });

  it("reads a thread opened after a same-position rewrite against the list it was opened with", async () => {
    navigation.accountIndex = "0";
    window.history.replaceState(
      null,
      "",
      "/mail/u/0/all-inboxes/inbox/thread-c?account=2",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-2", "account-3"]),
        )
        .mockResolvedValueOnce(listResponse(["account-1", "account-3"]))
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-3", "account-4"]),
        ),
    );
    const { rerender } = render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-2,account-3",
      ),
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/mail/u/0/all-inboxes/inbox/thread-c?account=1",
      ),
    );
    // The router lands, then the user opens an account-3 thread.
    window.history.replaceState(
      null,
      "",
      "/mail/u/0/all-inboxes/inbox/thread-c?account=1",
    );
    rerender(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    window.history.replaceState(
      null,
      "",
      "/mail/u/0/all-inboxes/inbox/thread-d?account=1",
    );
    rerender(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-3,account-4",
      ),
    );

    // Adding an account moves nobody, so the open thread stays as it is.
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it("reads an address the app canonicalised against the list it was written for", async () => {
    navigation.accountIndex = "0";
    window.history.replaceState(null, "", "/mail/u/0");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-2", "account-3", "account-4"]),
        )
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-3", "account-4"]),
        )
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-3", "account-4", "account-5"]),
        ),
    );
    const { rerender } = render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-2,account-3,account-4",
      ),
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/mail/u/0/inbox"),
    );
    window.history.replaceState(null, "", "/mail/u/0/inbox");
    rerender(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );
    // An account-4 thread, at its position in the list without account 2.
    window.history.replaceState(
      null,
      "",
      "/mail/u/0/all-inboxes/inbox/thread-d?account=2",
    );
    rerender(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(screen.getByTestId("account-ids").textContent).toBe(
        "account-1,account-3,account-4,account-5",
      ),
    );

    expect(navigation.replace).not.toHaveBeenCalledWith(
      "/mail/u/0/all-inboxes/inbox/thread-d?account=1",
    );
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it("keeps the pinned account when the router lands on an intermediate rewrite", async () => {
    navigation.accountIndex = "3";
    window.history.replaceState(null, "", "/mail/u/3/inbox");
    const fourAccounts = ["account-1", "account-2", "account-3", "account-4"];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(listResponse(fourAccounts))
        .mockResolvedValueOnce(listResponse(fourAccounts.slice(1)))
        .mockResolvedValueOnce(listResponse(fourAccounts.slice(2))),
    );
    const shown: string[] = [];
    function RecordAccount() {
      shown.push(useAccount().emailAccountId);
      return null;
    }
    const tree = () => (
      <EmailAccountProvider>
        <RecordAccount />
        <AccountState />
      </EmailAccountProvider>
    );
    const { rerender } = render(tree());
    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-4"),
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith("/mail/u/2/inbox"),
    );
    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith("/mail/u/1/inbox"),
    );
    cookie.setLastAccount.mockClear();

    // The first rewrite lands after the second was sent.
    navigation.accountIndex = "2";
    window.history.replaceState(null, "", "/mail/u/2/inbox");
    rerender(tree());

    expect(screen.getByTestId("account-id").textContent).toBe("account-4");
    expect(shown.filter((id) => id && id !== "account-4")).toEqual([]);
    expect(cookie.setLastAccount).not.toHaveBeenCalledWith({
      emailAccountId: "account-3",
    });
  });

  it("forgets the pinned account's old position once the user navigates", async () => {
    navigation.accountIndex = "1";
    window.history.replaceState(null, "", "/mail/u/1/inbox");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          listResponse(["account-1", "account-2", "account-3"]),
        )
        .mockResolvedValueOnce(listResponse(["account-2", "account-3"])),
    );
    const tree = () => (
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>
    );
    const { rerender } = render(tree());
    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-2"),
    );

    await fetchEmailAccounts();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/mail/u/0/inbox"),
    );
    // Before the rewrite lands, the user opens Sent for the same account.
    navigation.accountIndex = "0";
    window.history.replaceState(null, "", "/mail/u/0/sent");
    rerender(tree());
    expect(screen.getByTestId("account-id").textContent).toBe("account-2");

    // Then switches to account 3, which is now at position 1.
    navigation.accountIndex = "1";
    window.history.replaceState(null, "", "/mail/u/1/inbox");
    rerender(tree());

    await waitFor(() =>
      expect(screen.getByTestId("account-id").textContent).toBe("account-3"),
    );
  });

  it("does not replace a global route when remaining accounts exist", async () => {
    navigation.emailAccountId = "deleted-account";
    window.history.replaceState(null, "", "/accounts");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => accountResponse("account-1"),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await screen.findByText("ready with an account");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not replace a deleted account route when no accounts remain", async () => {
    navigation.emailAccountId = "deleted-account";
    window.history.replaceState(null, "", "/deleted-account/mail");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ emailAccounts: [], lastEmailAccountId: null }),
      }),
    );

    render(
      <EmailAccountProvider>
        <AccountState />
      </EmailAccountProvider>,
    );

    await screen.findByText("ready without an account");
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

const SERVER_ACCOUNTS = [
  { id: "account-1", email: "one@example.com", provider: "google" },
  { id: "account-2", email: "two@example.com", provider: "microsoft" },
];

const THREE_SERVER_ACCOUNTS = [
  ...SERVER_ACCOUNTS,
  { id: "account-3", email: "three@example.com", provider: "google" },
];

function threeAccountsList() {
  return THREE_SERVER_ACCOUNTS.map((account) => ({
    id: account.id,
    email: account.email,
    account: { provider: account.provider },
    providerRateLimit: null,
  }));
}

function threeAccountsResponse() {
  return {
    ok: true,
    json: async () => ({
      emailAccounts: threeAccountsList(),
      lastEmailAccountId: "account-2",
    }),
  };
}

function listResponse(ids: string[]) {
  return {
    ok: true,
    json: async () => ({
      emailAccounts: ids.map((id) => ({
        id,
        email: `${id}@example.com`,
        account: { provider: "google" },
        providerRateLimit: null,
      })),
      lastEmailAccountId: ids[0],
    }),
  };
}

function AccountState() {
  const { accountIds, emailAccountId, isLoading, provider, userEmail } =
    useAccount();

  return (
    <span>
      {isLoading
        ? "loading"
        : `ready ${emailAccountId ? "with" : "without"} an account`}
      <span data-testid="account-id">{emailAccountId}</span>
      <span data-testid="provider">{provider}</span>
      <span data-testid="user-email">{userEmail}</span>
      <span data-testid="account-ids">{accountIds.join(",")}</span>
    </span>
  );
}

function accountResponse(lastEmailAccountId: string | null) {
  return {
    emailAccounts: [
      {
        id: "account-1",
        email: "one@example.com",
        account: { provider: "google" },
        providerRateLimit: null,
      },
      {
        id: "account-2",
        email: "two@example.com",
        account: { provider: "google" },
        providerRateLimit: null,
      },
    ],
    lastEmailAccountId,
  };
}
