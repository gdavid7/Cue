// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigation } from "./SideNav";

const mocks = vi.hoisted(() => ({ allAccounts: false }));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useCleanerEnabled: () => false,
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
  useTodayHref: () => (mocks.allAccounts ? "/a/home?accounts=all" : "/a/home"),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "a",
    emailAccount: { id: "a", email: "a@example.com" },
    provider: "google",
  }),
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
});
