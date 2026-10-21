// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swrFetcher } from "@/providers/swr-fetcher";
import { ScheduledEmailList } from "./ScheduledEmailList";
import { SnoozedThreadList } from "./SnoozedThreadList";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  requestSync: vi.fn(),
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({ requestSync: mocks.requestSync }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-a" }),
}));
vi.mock("@/hooks/useMailHref", () => ({
  useMailHref:
    () =>
    ({ accountId = "account-a" }: { accountId?: string } = {}) =>
      `/mail/${accountId}/sent`,
}));
vi.mock("@/utils/actions/scheduled-email", () => ({
  cancelScheduledEmailAction: mocks.cancel,
  retryScheduledEmailAction: vi.fn(),
}));

const ACCOUNTS = [
  {
    id: "account-a",
    email: "a@example.com",
    name: null,
    image: null,
    provider: "google",
  },
  {
    id: "account-b",
    email: "b@example.com",
    name: null,
    image: null,
    provider: "google",
  },
];

// What each account's own request returns, by the account header.
let byAccount: Record<string, unknown> = {};
const requests: { url: string; method: string; accountId: string | null }[] =
  [];

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  mocks.requestSync.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get("X-Email-Account-ID");
      const method = init?.method ?? "GET";
      requests.push({ url, method, accountId });
      if (method === "DELETE")
        return Response.json({ unsnoozedThreadIds: ["thread-b"] });
      const body = accountId ? byAccount[accountId] : undefined;
      return body
        ? Response.json(body)
        : Response.json({ error: "Boom" }, { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SnoozedThreadList across accounts", () => {
  it("lists every account's snoozes, soonest first, each naming its account, and acts in it", async () => {
    byAccount = {
      "account-a": { threads: [snoozed("thread-a", "Later one", 3)] },
      "account-b": { threads: [snoozed("thread-b", "Sooner one", 1)] },
    };
    const onOpenThread = vi.fn();
    renderWithSWR(
      <SnoozedThreadList accounts={ACCOUNTS} onOpenThread={onOpenThread} />,
    );

    const list = await screen.findByRole("list", {
      name: "Snoozed conversations",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Sooner one"),
      expect.stringContaining("Later one"),
    ]);
    expect(
      within(items[0]).getByRole("img", { name: "Account: b@example.com" }),
    ).toBeTruthy();

    fireEvent.click(within(items[0]).getByText("Sooner one"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-b", "account-b");

    await act(async () => {
      fireEvent.click(
        within(items[0]).getByRole("button", { name: "Unsnooze" }),
      );
    });
    expect(requests.find((r) => r.method === "DELETE")?.accountId).toBe(
      "account-b",
    );
    expect(mocks.requestSync).toHaveBeenCalledWith(["account-b"]);
  });

  it("names an account whose snoozes didn't load and keeps the other's", async () => {
    byAccount = {
      "account-a": { threads: [snoozed("thread-a", "Still here", 1)] },
    };
    renderWithSWR(
      <SnoozedThreadList accounts={ACCOUNTS} onOpenThread={vi.fn()} />,
    );

    expect(await screen.findByText("Still here")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "b@example.com couldn't be loaded",
    );
  });

  it("one account: asks only that account, with no account marker", async () => {
    byAccount = { "account-a": { threads: [snoozed("thread-a", "Mine", 1)] } };
    renderWithSWR(<SnoozedThreadList onOpenThread={vi.fn()} />);

    expect(await screen.findByText("Mine")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(new Set(requests.map((r) => r.accountId))).toEqual(
      new Set(["account-a"]),
    );
  });
});

describe("ScheduledEmailList across accounts", () => {
  it("cancels a send in its own account", async () => {
    byAccount = {
      "account-a": { scheduledEmails: [scheduled("send-a", "First", 2)] },
      "account-b": { scheduledEmails: [scheduled("send-b", "Second", 1)] },
    };
    mocks.cancel.mockResolvedValue({});
    renderWithSWR(<ScheduledEmailList accounts={ACCOUNTS} />);

    const list = await screen.findByRole("list", { name: "Scheduled emails" });
    // Every request is made as an account; none goes out without one.
    expect(requests.map((request) => request.accountId)).not.toContain(null);
    const [first] = within(list).getAllByRole("listitem");
    expect(first.textContent).toContain("Second");
    expect(
      within(first).getByRole("img", { name: "Account: b@example.com" }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        within(first).getByRole("button", { name: "Cancel send" }),
      );
    });
    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith("account-b", { id: "send-b" }),
    );
  });
});

function renderWithSWR(ui: React.ReactNode) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        // As the app's: an account-scoped key is fetched as that account.
        fetcher: ([url, accountId]: [string, string]) =>
          swrFetcher(url, undefined, accountId),
      }}
    >
      {ui}
    </SWRConfig>,
  );
}

function snoozed(threadId: string, subject: string, hours: number) {
  return {
    id: `snooze-${threadId}`,
    threadId,
    subject,
    from: "Grace <grace@example.com>",
    snippet: "",
    status: "PENDING",
    scheduledFor: new Date(Date.now() + hours * 3_600_000).toISOString(),
  };
}

function scheduled(id: string, subject: string, hours: number) {
  return {
    id,
    status: "PENDING",
    sendAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
    threadId: null,
    error: null,
    to: "sam@example.com",
    subject,
    draftMessageIds: [],
  };
}
