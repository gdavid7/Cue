// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContent } from "@/app/(app)/settings/SettingsContent";

const { accounts, premium } = vi.hoisted(() => ({
  accounts: {
    isLoading: true,
    data: undefined as unknown,
    error: undefined as unknown,
  },
  premium: { canManageBilling: false },
}));

vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => accounts }));
vi.mock("@/hooks/usePremium", () => ({ usePremium: () => premium }));
vi.mock("@/hooks/useMessagingChannels", () => ({
  useMessagingChannels: () => ({ data: undefined }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: false,
    NEXT_PUBLIC_EXTERNAL_API_ENABLED: false,
  },
}));
vi.mock("@/utils/user", () => ({ logOut: vi.fn() }));
vi.mock("@/app/(app)/[emailAccountId]/settings/ConnectedAppsSection", () => ({
  useSlackNotifications: vi.fn(),
}));
vi.mock("@/app/(app)/[emailAccountId]/settings/BillingSection", () => ({
  BillingSection: () => <div>billing-body</div>,
}));

// Each of these makes its own requests; the layout test does not need them.
vi.mock("@/app/(app)/[emailAccountId]/settings/ApiKeysSection", () => ({
  ApiKeysSection: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/settings/McpSection", () => ({
  McpSection: () => null,
}));
vi.mock("@/app/(app)/settings/EmailOtpSection", () => ({
  EmailOtpSection: () => null,
}));
vi.mock("@/app/(app)/settings/AppearanceSection", () => ({
  AppearanceSection: () => null,
}));
vi.mock("@/app/(app)/settings/NotificationsSection", () => ({
  NotificationsSection: () => null,
}));
vi.mock("@/app/(app)/settings/TodayWeatherSetting", () => ({
  TodayWeatherSetting: () => null,
}));
vi.mock("@/app/(app)/settings/PreSendCheckSetting", () => ({
  PreSendCheckSetting: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/settings/CleanupDraftsSection", () => ({
  CleanupDraftsSection: () => null,
}));
vi.mock(
  "@/app/(app)/[emailAccountId]/settings/SentMessageOpenTrackingSetting",
  () => ({ SentMessageOpenTrackingSetting: () => null }),
);
vi.mock(
  "@/app/(app)/[emailAccountId]/settings/VacationResponderSetting",
  () => ({ VacationResponderSetting: () => null }),
);
vi.mock("@/app/(app)/[emailAccountId]/settings/DeleteSection", () => ({
  DeleteSection: () => null,
}));
vi.mock(
  "@/app/(app)/[emailAccountId]/settings/OrgAnalyticsConsentSection",
  () => ({ OrgAnalyticsConsentSection: () => null }),
);
vi.mock("@/app/(app)/[emailAccountId]/settings/ResetAnalyticsSection", () => ({
  ResetAnalyticsSection: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/settings/CopyRulesSection", () => ({
  CopyRulesSection: () => null,
}));
vi.mock(
  "@/app/(app)/[emailAccountId]/assistant/settings/RuleImportExportSetting",
  () => ({ RuleImportExportSetting: () => null }),
);
vi.mock("@/app/(app)/[emailAccountId]/settings/ToggleAllRulesSection", () => ({
  ToggleAllRulesSection: () => null,
}));
vi.mock("@/components/CueLabelsCleanup", () => ({
  CueLabelsSetting: () => null,
}));

describe("SettingsContent layout stability", () => {
  beforeEach(() => {
    accounts.isLoading = true;
    accounts.data = undefined;
    premium.canManageBilling = false;
  });
  afterEach(cleanup);

  it("reserves the email accounts area while accounts load", () => {
    render(<SettingsContent />);

    expect(screen.getByTestId("email-accounts-skeleton")).toBeTruthy();
    expect(screen.getByText("Email accounts")).toBeTruthy();
  });

  it("swaps the skeleton for the accounts once loaded", () => {
    accounts.isLoading = false;
    accounts.data = {
      emailAccounts: [
        {
          id: "account-1",
          email: "me@example.com",
          name: "Me",
          image: null,
          account: { provider: "google" },
        },
      ],
    };
    render(<SettingsContent />);

    expect(screen.queryByTestId("email-accounts-skeleton")).toBeNull();
    expect(screen.getByText("me@example.com")).toBeTruthy();
  });

  it("puts Billing after every other group so it cannot push them", () => {
    premium.canManageBilling = true;
    render(<SettingsContent />);

    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe("Billing");
    expect(headings.indexOf("Email accounts")).toBeLessThan(
      headings.indexOf("Account"),
    );
  });
});
