// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import type { Cache } from "swr";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ACCOUNT_ID_REQUIRED_ERROR } from "@/utils/config";
import { SWRProvider } from "./SWRProvider";
import { resetSwrPersistenceBlocksForTesting } from "@/utils/swr-persistence";

const accountState = { emailAccountId: "account-a" };

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => accountState,
}));

vi.mock("@/utils/error", () => ({
  captureException: vi.fn(),
}));

let scopedCache: Cache | undefined;

function CacheProbe() {
  scopedCache = useSWRConfig().cache;
  return null;
}

function snapshotKey(accountId: string) {
  return `inbox-zero:swr:v2:${accountId}`;
}

describe("SWRProvider persisted cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSwrPersistenceBlocksForTesting();
    accountState.emailAccountId = "account-a";
    scopedCache = undefined;
  });

  it("hydrates whitelisted entries into the live cache after mount", async () => {
    window.localStorage.setItem(
      snapshotKey("account-a"),
      JSON.stringify({ "/api/labels": { labels: ["a-label"] } }),
    );

    render(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toEqual({
        labels: ["a-label"],
      });
    });
  });

  it("clears a first-paint cache once an account id appears", async () => {
    accountState.emailAccountId = "";
    window.localStorage.setItem(
      snapshotKey("account-a"),
      JSON.stringify({ "/api/labels": { labels: ["a-label"] } }),
    );

    const view = render(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(scopedCache).toBeDefined();
    });
    scopedCache?.set("/api/labels", {
      data: { labels: ["stale-without-account"] },
    });

    accountState.emailAccountId = "account-a";
    view.rerender(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toEqual({
        labels: ["a-label"],
      });
    });
  });

  it("revalidates a cached missing-account 403 when the account id appears", async () => {
    accountState.emailAccountId = "";
    let shouldFail = true;
    const fetcher = vi.fn(async () => {
      if (shouldFail) {
        const error = new Error(EMAIL_ACCOUNT_ID_REQUIRED_ERROR) as Error & {
          status?: number;
        };
        error.status = 403;
        throw error;
      }
      return { emailAccount: { id: "account-a" } };
    });

    function EmailAccountProbe() {
      const { data, error } = useSWR("/api/user/email-account", fetcher, {
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      return (
        <div data-testid="status">
          {error ? "error" : data ? "ok" : "loading"}
        </div>
      );
    }

    const view = render(
      <SWRProvider>
        <EmailAccountProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("status").textContent).toBe("error");
    });

    shouldFail = false;
    accountState.emailAccountId = "account-a";
    view.rerender(
      <SWRProvider>
        <EmailAccountProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("status").textContent).toBe("ok");
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("replaces whitelisted entries on account switch instead of leaking them", async () => {
    window.localStorage.setItem(
      snapshotKey("account-a"),
      JSON.stringify({
        "/api/labels": { labels: ["a-label"] },
        "/api/labels/counts": { counts: ["a-counts"] },
      }),
    );
    window.localStorage.setItem(
      snapshotKey("account-b"),
      JSON.stringify({ "/api/labels": { labels: ["b-label"] } }),
    );

    const view = render(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );
    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toEqual({
        labels: ["a-label"],
      });
    });

    scopedCache?.set("/api/mail/settings", {
      data: { splits: [{ id: "a-split", values: ["a-label"] }] },
    });

    accountState.emailAccountId = "account-b";
    view.rerender(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toEqual({
        labels: ["b-label"],
      });
      // account-b has no counts snapshot: account-a's value must be gone.
      expect(scopedCache?.get("/api/labels/counts")?.data).toBeUndefined();
      expect(scopedCache?.get("/api/mail/settings")?.data).toBeUndefined();
    });
  });

  it("never shows the previous account's data when the new account's load fails", async () => {
    let account = "account-a";
    const fetcher = vi.fn(async () => {
      if (account === "account-b") {
        throw Object.assign(new Error("Server error"), { status: 500 });
      }
      return { owner: account };
    });

    function GroupProbe() {
      const { data, error } = useSWR<{ owner: string }>(
        "/api/user/group",
        fetcher,
        {
          shouldRetryOnError: false,
          revalidateOnFocus: false,
          dedupingInterval: 0,
        },
      );
      // As LoadingContent with hasData: data stays on screen through an error.
      return (
        <div data-testid="group">
          {data ? data.owner : error ? "error" : "loading"}
        </div>
      );
    }

    const view = render(
      <SWRProvider>
        <GroupProbe />
      </SWRProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId("group").textContent).toBe("account-a");
    });

    account = "account-b";
    accountState.emailAccountId = "account-b";
    view.rerender(
      <SWRProvider>
        <GroupProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("group").textContent).toBe("error");
    });
  });

  it("never shows the previous account's pages in an infinite list", async () => {
    let account = "account-a";
    const fetcher = vi.fn(async (key: string) => {
      if (account === "account-b") {
        throw Object.assign(new Error("Server error"), { status: 500 });
      }
      return { threads: [`${account} ${key}`] };
    });

    function ThreadListProbe() {
      const { data, error } = useSWRInfinite<{ threads: string[] }>(
        (index) => (index < 2 ? `/api/threads?page=${index}` : null),
        fetcher,
        {
          initialSize: 2,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
          dedupingInterval: 0,
        },
      );
      return (
        <div data-testid="threads">
          {data
            ? data.flatMap((page) => page.threads).join(", ")
            : error
              ? "error"
              : "loading"}
        </div>
      );
    }

    const view = render(
      <SWRProvider>
        <ThreadListProbe />
      </SWRProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId("threads").textContent).toBe(
        "account-a /api/threads?page=0, account-a /api/threads?page=1",
      );
    });

    account = "account-b";
    accountState.emailAccountId = "account-b";
    view.rerender(
      <SWRProvider>
        <ThreadListProbe />
      </SWRProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("threads").textContent).toBe("error");
    });
  });

  it("persists the active account's whitelisted entries on pagehide", async () => {
    window.localStorage.setItem(
      snapshotKey("account-a"),
      JSON.stringify({ "/api/labels": { labels: ["a-label"] } }),
    );

    render(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );
    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toBeDefined();
    });

    window.localStorage.clear();
    window.dispatchEvent(new Event("pagehide"));

    expect(
      JSON.parse(window.localStorage.getItem(snapshotKey("account-a")) ?? "{}"),
    ).toEqual({ "/api/labels": { labels: ["a-label"] } });
  });

  it("stops persisting an account after another tab removes its snapshot", async () => {
    window.localStorage.setItem(
      snapshotKey("account-a"),
      JSON.stringify({ "/api/labels": { labels: ["a-label"] } }),
    );

    render(
      <SWRProvider>
        <CacheProbe />
      </SWRProvider>,
    );
    await waitFor(() => {
      expect(scopedCache?.get("/api/labels")?.data).toBeDefined();
    });

    // Another tab logging out removes the snapshot and fires a storage event.
    window.localStorage.removeItem(snapshotKey("account-a"));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: snapshotKey("account-a"),
        newValue: null,
      }),
    );
    window.dispatchEvent(new Event("pagehide"));

    expect(window.localStorage.getItem(snapshotKey("account-a"))).toBeNull();
  });
});
