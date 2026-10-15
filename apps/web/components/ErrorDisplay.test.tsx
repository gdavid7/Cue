// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorDisplay } from "@/components/ErrorDisplay";

const swr = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: swr.mutate }) }));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.com" },
}));

describe("ErrorDisplay", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a raw server error out of the headline and offers a retry", () => {
    const onRetry = vi.fn();
    render(
      <ErrorDisplay
        error={{ error: "PrismaClientKnownRequestError: P2025" }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Couldn't load this")).toBeTruthy();
    expect(
      screen.getByText("Check your connection and try again.", {
        exact: false,
      }),
    ).toBeTruthy();
    // The raw detail is still there for support, folded away.
    expect(
      screen
        .getByText("PrismaClientKnownRequestError: P2025")
        .closest("details"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows a message the server wrote for the user", () => {
    render(
      <ErrorDisplay
        error={{
          info: { error: "This rule no longer exists.", isKnownError: true },
        }}
      />,
    );

    expect(screen.getByText("This rule no longer exists.")).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
  });

  it("retries by revalidating loaded data when no handler is given", () => {
    render(<ErrorDisplay error={{ error: "Failed to fetch" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(swr.mutate).toHaveBeenCalledOnce();
  });

  it("announces the failure to assistive technology", () => {
    render(<ErrorDisplay error={{ error: "Failed to fetch" }} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load this",
    );
  });

  it("renders nothing without an error", () => {
    const { container } = render(<ErrorDisplay error={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
