// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchAnswerCard } from "./SearchAnswerCard";

const swr = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false, error: undefined } as {
    data: unknown;
    isLoading: boolean;
    error: unknown;
  },
}));

vi.mock("swr", () => ({ default: () => swr.result }));
vi.mock("@/utils/swr", () => ({ getAccountScopedKey: (key: string) => key }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account", accountIds: ["account"] }),
}));

afterEach(() => {
  cleanup();
  swr.result = { data: undefined, isLoading: false, error: undefined };
});

describe("SearchAnswerCard", () => {
  it("offers to ask in chat, with the search, when nothing matches", () => {
    const onContinueInChat = vi.fn();
    render(
      <SearchAnswerCard
        emailAccountId="account"
        noResults
        onContinueInChat={onContinueInChat}
        query="when is the offsite"
      />,
    );

    expect(
      screen.getByText("No emails match “when is the offsite”."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Cue in chat →" }));
    expect(onContinueInChat).toHaveBeenCalledWith("when is the offsite");
  });

  it("leaves the results alone when the search found mail", () => {
    const { container } = render(
      <SearchAnswerCard
        emailAccountId="account"
        noResults={false}
        onContinueInChat={vi.fn()}
        query="offsite"
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("says nothing matched while the answer is still being read", () => {
    swr.result = { data: undefined, isLoading: true, error: undefined };
    render(
      <SearchAnswerCard
        emailAccountId="account"
        noResults
        onContinueInChat={vi.fn()}
        query="offsite"
      />,
    );

    expect(screen.getByText("No emails match “offsite”.")).toBeTruthy();
    expect(screen.getByText("Reading your mail…")).toBeTruthy();
  });

  it("names the account it answered from above mail from several accounts", () => {
    swr.result = {
      data: { answer: "The offsite is on Friday.", sources: [] },
      isLoading: false,
      error: undefined,
    };
    render(
      <SearchAnswerCard
        accountEmail="a@example.com"
        emailAccountId="account"
        noResults={false}
        onContinueInChat={vi.fn()}
        query="when is the offsite"
      />,
    );

    expect(screen.getByText("From a@example.com")).toBeTruthy();
  });
});
