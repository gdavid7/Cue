// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPageAccountScope,
  getTodayPath,
  useTodayHref,
} from "./useTodayHref";

const mocks = vi.hoisted(() => ({
  pathname: "/mail/u/0/inbox",
  search: "",
  emailAccounts: [] as unknown[],
  emailAccountId: "account-a",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ data: { emailAccounts: mocks.emailAccounts } }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: mocks.emailAccountId }),
}));

describe("useTodayHref", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.emailAccounts = [account("account-a"), account("account-b")];
    mocks.emailAccountId = "account-a";
  });
  afterEach(() => window.localStorage.clear());

  it("opens Today across accounts from All inboxes", () => {
    at("/mail/u/0/all-inboxes/inbox");
    expect(renderHook(() => useTodayHref()).result.current).toBe(
      "/account-a/home?accounts=all",
    );
  });

  it("opens the account's Today from one account's mail", () => {
    at("/mail/u/0/inbox");
    expect(renderHook(() => useTodayHref()).result.current).toBe(
      "/account-a/home",
    );
  });

  it("keeps the scope on Today across accounts", () => {
    at("/account-a/home", "accounts=all");
    expect(renderHook(() => useTodayHref()).result.current).toBe(
      "/account-a/home?accounts=all",
    );
  });

  it("on an account's own page, follows where the user last looked", () => {
    at("/mail/u/0/all-inboxes/inbox");
    const mail = renderHook(() => useTodayHref());
    mail.unmount();

    at("/account-a/automation");
    const { result } = renderHook(() => useTodayHref());
    expect(result.current).toBe("/account-a/home?accounts=all");

    at("/mail/u/0/inbox");
    renderHook(() => useTodayHref()).unmount();
    expect(window.localStorage.getItem("cue:account-scope")).toBe("account");
    at("/account-a/automation");
    expect(renderHook(() => useTodayHref()).result.current).toBe(
      "/account-a/home",
    );
  });

  it("has no Today to open until there is an account", () => {
    mocks.emailAccountId = "";
    at("/mail/u/0/all-inboxes/inbox");
    expect(renderHook(() => useTodayHref()).result.current).toBeNull();
  });

  it("is one account's Today with one account in All inboxes", () => {
    mocks.emailAccounts = [
      account("account-a"),
      { ...account("account-b"), includeInAllAccounts: false },
    ];
    at("/mail/u/0/all-inboxes/inbox");
    expect(renderHook(() => useTodayHref()).result.current).toBe(
      "/account-a/home",
    );
  });
});

describe("getPageAccountScope", () => {
  it("reads All inboxes, Today and other pages", () => {
    expect(getPageAccountScope("/mail/u/1/all-inboxes/sent", "")).toBe("all");
    expect(getPageAccountScope("/mail/u/1/sent", "")).toBe("account");
    expect(getPageAccountScope("/a/home", "accounts=all")).toBe("all");
    expect(getPageAccountScope("/a/home", "")).toBe("account");
    expect(getPageAccountScope("/a/automation", "")).toBeNull();
  });

  it("builds Today's path for either scope", () => {
    expect(getTodayPath("a", false)).toBe("/a/home");
    expect(getTodayPath("a", true)).toBe("/a/home?accounts=all");
  });
});

function at(pathname: string, search = "") {
  mocks.pathname = pathname;
  mocks.search = search;
}

function account(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    image: null,
    includeInAllAccounts: true,
    account: { disconnectedAt: null, provider: "google" },
  };
}
