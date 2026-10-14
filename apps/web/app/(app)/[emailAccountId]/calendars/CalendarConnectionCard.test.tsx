/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarConnectionCard } from "./CalendarConnectionCard";

const { mockDisconnect, mockMutate, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockDisconnect: vi.fn(),
    mockMutate: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "email-account-id" }),
}));

vi.mock("@/hooks/useCalendars", () => ({
  useCalendars: () => ({ data: undefined, mutate: mockMutate }),
}));

vi.mock("@/utils/actions/calendar", () => ({
  disconnectCalendarAction: mockDisconnect,
  toggleCalendarAction: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  toastSuccess: mockToastSuccess,
  toastError: mockToastError,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CalendarConnectionCard", () => {
  it("refreshes the connections only after the confirmed disconnect lands", async () => {
    let finishDisconnect: (value: unknown) => void = () => {};
    mockDisconnect.mockReturnValue(
      new Promise((resolve) => {
        finishDisconnect = resolve;
      }),
    );
    render(<CalendarConnectionCard connection={connection()} />);

    await chooseDisconnect();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Disconnect user@example.com?");
    expect(mockDisconnect).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });

    await waitFor(() =>
      expect(mockDisconnect).toHaveBeenCalledWith("email-account-id", {
        connectionId: "connection-id",
      }),
    );
    // Refetching while the delete is in flight returns the connection again,
    // so the card would stay on screen as if nothing happened.
    expect(mockMutate).not.toHaveBeenCalled();

    await act(async () => {
      finishDisconnect({ data: { success: true } });
    });

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    expect(mockToastSuccess).toHaveBeenCalledWith({
      description: "Calendar disconnected",
    });
  });

  it("tells the user when the disconnect fails", async () => {
    mockDisconnect.mockResolvedValue({ serverError: "Connection not found" });
    render(<CalendarConnectionCard connection={connection()} />);

    await chooseDisconnect();
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Connection not found" }),
      ),
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("does not disconnect when the confirmation is cancelled", async () => {
    render(<CalendarConnectionCard connection={connection()} />);

    await chooseDisconnect();
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
});

async function chooseDisconnect() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Calendar options" }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", { name: "Disconnect" });
  await act(async () => {
    fireEvent.click(item);
  });
}

function connection() {
  return {
    id: "connection-id",
    provider: "google",
    email: "user@example.com",
    isConnected: true,
    calendars: [],
  } as unknown as Parameters<typeof CalendarConnectionCard>[0]["connection"];
}
