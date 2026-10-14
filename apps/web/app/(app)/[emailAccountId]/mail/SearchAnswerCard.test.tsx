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

afterEach(cleanup);

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

    expect(screen.getByText("No emails match.")).toBeTruthy();
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
});
