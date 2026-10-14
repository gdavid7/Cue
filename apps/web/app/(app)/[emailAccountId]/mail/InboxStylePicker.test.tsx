// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxStyleCard } from "@/app/(app)/[emailAccountId]/mail/InboxStylePicker";

const mocks = vi.hoisted(() => ({
  applyInboxStyleAction: vi.fn(),
  dismissHintAction: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/utils/actions/mail-split", () => ({
  applyInboxStyleAction: mocks.applyInboxStyleAction,
}));
vi.mock("@/utils/actions/hints", () => ({
  dismissHintAction: mocks.dismissHintAction,
}));
vi.mock("@/components/Toast", () => ({ toastSuccess: mocks.toastSuccess }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "google" }),
}));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({ data: { dismissedHints: [] }, mutate: vi.fn() }),
}));
vi.mock("@/hooks/useMailSettings", () => ({
  useMailSettings: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useSignupEvent", () => ({ useSignUpEvent: () => undefined }));

const CARD = { name: "Let Cue find what needs you" };

describe("InboxStyleCard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("waits for the list before asking", () => {
    render(<InboxStyleCard ready={false} onDone={vi.fn()} />);
    expect(screen.queryByRole("region", CARD)).toBeNull();
  });

  it("closes for now without starting the tour or deciding for good", () => {
    const onDone = vi.fn();
    render(<InboxStyleCard ready onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("region", CARD)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(mocks.dismissHintAction).not.toHaveBeenCalled();

    // Still closed when the mail view remounts in the same session.
    cleanup();
    render(<InboxStyleCard ready onDone={onDone} />);
    expect(screen.queryByRole("region", CARD)).toBeNull();
  });

  it("confirms the choice, then hands over to the tour", async () => {
    mocks.applyInboxStyleAction.mockResolvedValue({});
    mocks.dismissHintAction.mockResolvedValue({});
    const onDone = vi.fn();
    render(<InboxStyleCard ready onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Set up my inbox" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(mocks.applyInboxStyleAction).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ addCueTabs: true }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      description: "Tabs added. Needs reply fills in over the next minute.",
    });
    expect(mocks.dismissHintAction).toHaveBeenCalledOnce();
  });

  it("leads with Cue's own tabs, before the familiar layouts", () => {
    render(<InboxStyleCard ready onDone={vi.fn()} />);
    const cueTabs = screen.getByRole("checkbox", { name: /Needs reply/ });
    const [firstStyle] = screen.getAllByRole("radio");

    expect(cueTabs.getAttribute("aria-checked")).toBe("true");
    expect(
      cueTabs.compareDocumentPosition(firstStyle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("moves between styles with the arrow keys", () => {
    render(<InboxStyleCard ready onDone={vi.fn()} />);
    const [first, second] = screen.getAllByRole("radio");
    const checked = first.getAttribute("aria-checked") === "true";
    const start = checked ? first : second;
    const other = checked ? second : first;

    fireEvent.keyDown(start, { key: checked ? "ArrowRight" : "ArrowLeft" });

    expect(other.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(other);
  });
});
