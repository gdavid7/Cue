// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanAccountPicker } from "./CleanAccountPicker";

const mocks = vi.hoisted(() => ({
  allAccounts: true,
  emailAccounts: [] as unknown[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useTodayHref", () => ({
  useAllAccountsScope: () => mocks.allAccounts,
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ data: { emailAccounts: mocks.emailAccounts } }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "a",
    emailAccount: { id: "a", email: "a@example.com" },
  }),
}));

describe("CleanAccountPicker", () => {
  afterEach(() => {
    cleanup();
    mocks.allAccounts = true;
  });

  it("across accounts offers each included Gmail account, starting with this one", () => {
    mocks.emailAccounts = [
      account("a", "a@example.com", "google"),
      account("b", "b@example.com", "google"),
    ];

    render(<CleanAccountPicker />);

    expect(
      screen.getByRole("combobox", { name: "Account" }).textContent,
    ).toContain("a@example.com");
  });

  it("names the account it cleans when there is nothing to choose", () => {
    mocks.emailAccounts = [
      account("a", "a@example.com", "google"),
      account("b", "b@outlook.example", "microsoft-entra-id"),
      {
        ...account("c", "c@example.com", "google"),
        includeInAllAccounts: false,
      },
    ];

    render(<CleanAccountPicker />);

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("a@example.com")).toBeTruthy();
  });

  it("one account at a time: names the account, with no choice", () => {
    mocks.allAccounts = false;
    mocks.emailAccounts = [
      account("a", "a@example.com", "google"),
      account("b", "b@example.com", "google"),
    ];

    render(<CleanAccountPicker />);

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("a@example.com")).toBeTruthy();
  });

  it("says nothing for a user with one account", () => {
    mocks.emailAccounts = [account("a", "a@example.com", "google")];

    const { container } = render(<CleanAccountPicker />);

    expect(container.textContent).toBe("");
  });
});

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
