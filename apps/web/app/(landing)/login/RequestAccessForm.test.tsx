// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestAccessForm } from "@/app/(landing)/login/RequestAccessForm";

const { mockRequestAccess } = vi.hoisted(() => ({
  mockRequestAccess: vi.fn(),
}));

vi.mock("@/utils/actions/access", () => ({
  requestAccessAction: mockRequestAccess,
}));

describe("RequestAccessForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("confirms in place and moves focus to the confirmation", async () => {
    mockRequestAccess.mockResolvedValue({ data: { ok: true } });
    render(<RequestAccessForm />);

    fireEvent.change(screen.getByLabelText("Google account email"), {
      target: { value: " friend@gmail.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));

    const heading = await screen.findByRole("heading", {
      name: "You're on the list",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole("status").textContent).toContain(
      "friend@gmail.com",
    );
    expect(mockRequestAccess).toHaveBeenCalledWith(
      expect.objectContaining({ email: "friend@gmail.com" }),
    );
  });

  it("asks for a valid address before sending anything", async () => {
    render(<RequestAccessForm />);

    fireEvent.change(screen.getByLabelText("Google account email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));

    expect(await screen.findByText("Enter a valid email address")).toBeTruthy();
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });

  it("shows the server's reason inline when a request is refused", async () => {
    mockRequestAccess.mockResolvedValue({
      serverError: "Too many requests. Try again in a little while.",
    });
    render(<RequestAccessForm />);

    fireEvent.change(screen.getByLabelText("Google account email"), {
      target: { value: "friend@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many requests. Try again in a little while.",
    );
    expect(screen.queryByRole("heading", { name: "You're on the list" })).toBe(
      null,
    );
  });
});
