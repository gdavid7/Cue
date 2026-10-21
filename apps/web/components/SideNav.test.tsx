// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigation } from "./SideNav";

const mocks = vi.hoisted(() => ({
  allAccounts: false,
  today: true,
  cleaner: false,
  provider: "google",
  emailAccounts: [] as unknown[],
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useCleanerEnabled: () => mocks.cleaner,
  useMeetingBriefsEnabled: () => false,
  useMeetingRecorderEnabled: () => false,
}));
vi.mock("@/hooks/useCurrentOrganization", () => ({
  useCurrentOrganization: () => null,
}));
vi.mock("@/hooks/useMessagingChannels", () => ({
  useMessagingChannels: () => ({ data: undefined }),
}));
vi.mock("@/hooks/useMailHref", () => ({
  useMailHref:
    () =>
    ({ allInboxes }: { allInboxes?: boolean } = {}) =>
      allInboxes ? "/mail/u/0/all-inboxes/inbox" : "/mail/u/0/inbox",
}));
vi.mock("@/hooks/useTodayHref", () => ({
  useAllAccountsScope: () => mocks.allAccounts,
  useTodayHref: () => {
    if (!mocks.today) return null;
    return mocks.allAccounts ? "/a/home?accounts=all" : "/a/home";
  },
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "a",
    emailAccount: { id: "a", email: "a@example.com" },
    provider: mocks.provider,
  }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ data: { emailAccounts: mocks.emailAccounts } }),
}));
// Pulled in by the SideNav component, not the navigation it reads.
vi.mock("@/components/NavUser", () => ({ NavUser: () => null }));
vi.mock("@/components/PremiumCard", () => ({ PremiumCard: () => null }));
vi.mock("@/components/FeedbackDialog", () => ({
  FeedbackSidebarButton: () => null,
}));
vi.mock("@/components/connectors/ConnectorsList", () => ({
  ConnectorsList: () => null,
}));

describe("useNavigation", () => {
  afterEach(() => {
    mocks.today = true;
  });

  it("keeps Today in the list but disabled while there is no account", () => {
    mocks.today = false;
    const { manageItems } = renderHook(() => useNavigation()).result.current;
    const today = manageItems.find((i) => i.name === "Today");

    expect(today?.disabled).toBe(true);
    expect(today?.href).not.toContain("/home");
    expect(manageItems.find((i) => i.name === "Inbox")?.disabled).toBeFalsy();
  });

  it("across accounts: Inbox and Today keep the scope, and account pages name their account", () => {
    mocks.allAccounts = true;
    const { manageItems, toolsItems } = renderHook(() => useNavigation()).result
      .current;
    const item = (name: string) =>
      [...manageItems, ...toolsItems].find((i) => i.name === name);

    expect(item("Inbox")?.href).toBe("/mail/u/0/all-inboxes/inbox");
    expect(item("Today")?.href).toBe("/a/home?accounts=all");
    expect(item("Today")?.account).toBeUndefined();
    expect(item("Rules")?.account).toBe("a@example.com");
    expect(item("Chat")?.account).toBe("a@example.com");
    expect(item("Calendars")?.account).toBe("a@example.com");
  });

  it("one account: links as before, with no account named", () => {
    mocks.allAccounts = false;
    const { manageItems, toolsItems } = renderHook(() => useNavigation()).result
      .current;

    expect(manageItems.find((i) => i.name === "Inbox")?.href).toBe(
      "/mail/u/0/inbox",
    );
    expect(manageItems.find((i) => i.name === "Today")?.href).toBe("/a/home");
    expect(
      [...manageItems, ...toolsItems].every((i) => i.account === undefined),
    ).toBe(true);
  });

  describe("Deep Clean", () => {
    afterEach(() => {
      mocks.cleaner = false;
      mocks.provider = "google";
      mocks.emailAccounts = [];
    });

    it("across accounts opens in the open Gmail account, naming it", () => {
      Object.assign(mocks, {
        allAccounts: true,
        cleaner: true,
        emailAccounts: [
          account("a", "a@example.com", "google"),
          account("b", "b@example.com", "google"),
        ],
      });

      expect(deepClean()).toMatchObject({
        href: "/a/clean",
        account: "a@example.com",
      });
    });

    it("across accounts from an Outlook account opens in an included Gmail account", () => {
      Object.assign(mocks, {
        allAccounts: true,
        cleaner: true,
        provider: "microsoft-entra-id",
        emailAccounts: [
          account("a", "a@outlook.example", "microsoft-entra-id"),
          account("b", "b@example.com", "google"),
        ],
      });

      expect(deepClean()).toMatchObject({
        href: "/b/clean",
        account: "b@example.com",
      });
    });

    it("across accounts never opens in a Gmail account left out of All inboxes", () => {
      Object.assign(mocks, {
        allAccounts: true,
        cleaner: true,
        provider: "microsoft-entra-id",
        emailAccounts: [
          account("a", "a@outlook.example", "microsoft-entra-id"),
          account("c", "c@example.com", "google"),
          {
            ...account("b", "b@example.com", "google"),
            includeInAllAccounts: false,
          },
        ],
      });

      expect(deepClean()?.href).toBe("/c/clean");

      mocks.emailAccounts = mocks.emailAccounts
        .slice(0, 1)
        .concat(mocks.emailAccounts.slice(2));
      expect(deepClean()).toBeUndefined();
    });

    it("one account: only for Gmail, with no account named", () => {
      Object.assign(mocks, { allAccounts: false, cleaner: true });
      expect(deepClean()).toMatchObject({
        href: "/a/clean",
        account: undefined,
      });

      mocks.provider = "microsoft-entra-id";
      expect(deepClean()).toBeUndefined();
    });
  });
});

function deepClean() {
  const { toolsItems } = renderHook(() => useNavigation()).result.current;
  return toolsItems.find((item) => item.name === "Deep Clean");
}

function account(id: string, email: string, provider: string) {
  return {
    id,
    email,
    name: null,
    image: null,
    includeInAllAccounts: true,
    account: { disconnectedAt: null, provider },
  };
}
