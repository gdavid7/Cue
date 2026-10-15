// @vitest-environment jsdom
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUser } from "@/hooks/useUser";
import { GlobalProviders } from "./GlobalProviders";
import { SWRProvider } from "./SWRProvider";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-test" }),
}));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/welcome-upgrade" }));
const serwistState = vi.hoisted(() => ({
  serwist: undefined as { register: () => Promise<undefined> } | undefined,
}));
const { toastInfo, reloadPage } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  reloadPage: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));
// Like Serwist's provider, reloads the page whenever the browser comes back
// online unless `reloadOnOnline` is false.
vi.mock("@serwist/next/react", async () => {
  const { useEffect } = await import("react");
  return {
    SerwistProvider: ({
      children,
      reloadOnOnline = true,
    }: {
      children: ReactNode;
      reloadOnOnline?: boolean;
    }) => {
      useEffect(() => {
        if (!reloadOnOnline) return;
        window.addEventListener("online", reloadPage);
        return () => window.removeEventListener("online", reloadPage);
      }, [reloadOnOnline]);
      return children;
    },
    useSerwist: () => serwistState,
  };
});
vi.mock("nuqs/adapters/next/app", () => ({
  NuqsAdapter: ({ children }: { children: ReactNode }) => children,
}));

// jsdom has no matchMedia, which the theme provider reads to follow "System".
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
  }) as unknown as MediaQueryList;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  serwistState.serwist = undefined;
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher: undefined,
        shouldRetryOnError: false,
      }}
    >
      <GlobalProviders>{children}</GlobalProviders>
    </SWRConfig>
  );
}

describe("global user-data fetching", () => {
  it("loads the signed-in user outside the mailbox providers", async () => {
    const user = { id: "user-test", premium: null, canManageBilling: true };
    const fetch = vi.fn().mockResolvedValue(Response.json(user));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useUser(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(user));
    expect(fetch).toHaveBeenCalledWith("/api/user/me", expect.any(Object));
    expect(fetch.mock.calls[0][1].headers.has(EMAIL_ACCOUNT_HEADER)).toBe(
      false,
    );
  });

  it("treats an unauthenticated response as logged out", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Unauthorized" }, { status: 401 }),
        ),
    );
    const { result } = renderHook(() => useUser(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps service failures distinguishable from a signed-out session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Unavailable" }, { status: 503 }),
        ),
    );
    const { result } = renderHook(() => useUser(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data).toBeNull();
  });

  it("deduplicates user requests from multiple consumers", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ id: "user-test" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => [useUser(), useUser()], { wrapper });
    await waitFor(() =>
      expect(
        result.current.every((user) => user.data?.id === "user-test"),
      ).toBe(true),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the authenticated app fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: "user-test" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useUser(), {
      wrapper: ({ children }) => (
        <GlobalProviders>
          <SWRConfig value={{ provider: () => new Map(), fetcher }}>
            {children}
          </SWRConfig>
        </GlobalProviders>
      ),
    });
    await waitFor(() => expect(result.current.data?.id).toBe("user-test"));
    expect(fetcher).toHaveBeenCalledWith("/api/user/me");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch just by mounting the global providers", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <GlobalProviders>
        <span />
      </GlobalProviders>,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the selected account header inside the app provider", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "user-test" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useUser(), {
      wrapper: ({ children }) => (
        <GlobalProviders>
          <SWRProvider>{children}</SWRProvider>
        </GlobalProviders>
      ),
    });
    await waitFor(() => expect(result.current.data?.id).toBe("user-test"));
    expect(fetch.mock.calls[0][1].headers.get(EMAIL_ACCOUNT_HEADER)).toBe(
      "account-test",
    );
  });

  it("does not fetch when disabled", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderHook(() => useUser(false), { wrapper });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("service worker updates", () => {
  // QA-110: a new worker taking over (as can happen right after reconnecting)
  // reloaded the desktop page by itself, losing whatever was on screen.
  it("offers a reload instead of reloading when a new worker takes over", () => {
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: {},
      getRegistration: vi.fn(async () => undefined),
    });
    vi.stubGlobal(
      "navigator",
      Object.assign(Object.create(navigator), { serviceWorker }),
    );
    vi.stubGlobal("inboxZeroDesktop", {});
    serwistState.serwist = { register: () => new Promise(() => {}) };
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    render(<GlobalProviders>{null}</GlobalProviders>);
    now.mockReturnValue(1_000_000 + 60_000);
    serviceWorker.dispatchEvent(new Event("controllerchange"));

    expect(toastInfo).toHaveBeenCalledWith(
      "Update available",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reload" }),
      }),
    );
  });

  // Reconnecting reloaded every page, dropping a reply being written while
  // the network was away and racing the draft save that runs on reconnect.
  it("keeps the page when the network comes back", () => {
    render(<GlobalProviders>{null}</GlobalProviders>);

    window.dispatchEvent(new Event("online"));

    expect(reloadPage).not.toHaveBeenCalled();
  });
});
