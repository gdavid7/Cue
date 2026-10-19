// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftRepliesCard } from "@/app/(app)/[emailAccountId]/mail/DraftRepliesCard";

const mocks = vi.hoisted(() => ({
  setting: "unset" as "on" | "off" | "unset",
  toggleDraftReplies: vi.fn(),
  dismissedHints: [] as string[],
  dismissHint: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies", () => ({
  useDraftReplies: () => ({
    setting: mocks.setting,
    loading: false,
    error: undefined,
    toggleDraftReplies: mocks.toggleDraftReplies,
  }),
}));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({
    data: { dismissedHints: mocks.dismissedHints },
    mutate: vi.fn(),
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "ea_1", provider: "google" }),
}));
vi.mock("@/utils/actions/hints", () => ({
  dismissHintAction: (input: unknown) => {
    mocks.dismissHint(input);
    return Promise.resolve();
  },
}));
vi.mock("@/components/Toast", () => ({ toastError: mocks.toastError }));

const TITLE = "Cue can suggest replies for mail that needs one";

describe("DraftRepliesCard", () => {
  beforeEach(() => {
    mocks.setting = "unset";
    mocks.dismissedHints = ["inbox-style:ea_1"];
    mocks.toggleDraftReplies.mockReset();
    mocks.dismissHint.mockReset();
    mocks.toastError.mockReset();
  });
  afterEach(cleanup);

  it("asks a mailbox that never chose", () => {
    render(<DraftRepliesCard inboxStyleCardShown />);

    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
  });

  // Turned off is a choice; asking again would nag.
  it.each([
    "on",
    "off",
  ] as const)("stays away once drafting is %s", (setting) => {
    mocks.setting = setting;
    render(<DraftRepliesCard inboxStyleCardShown />);

    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });

  it("stays away once dismissed", () => {
    mocks.dismissedHints = ["inbox-style:ea_1", "draft-replies:ea_1"];
    render(<DraftRepliesCard inboxStyleCardShown />);

    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });

  it("waits for the inbox style card, but not when the list can't show it", () => {
    mocks.dismissedHints = [];
    const { rerender } = render(<DraftRepliesCard inboxStyleCardShown />);
    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();

    rerender(<DraftRepliesCard inboxStyleCardShown={false} />);
    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
  });

  it("turns drafting on and then goes for good", async () => {
    mocks.toggleDraftReplies.mockResolvedValue({ data: undefined });
    render(<DraftRepliesCard inboxStyleCardShown />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });

    expect(mocks.toggleDraftReplies).toHaveBeenCalledWith(true);
    expect(mocks.dismissHint).toHaveBeenCalledWith({
      hintId: "draft-replies:ea_1",
    });
    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });

  // A failed turn-on must not read as done: the card stays to try again.
  it("says why turning on failed and stays", async () => {
    const message =
      'You already have a rule named "To Reply". Rename it and try again.';
    mocks.toggleDraftReplies.mockRejectedValue(new Error(message));
    render(<DraftRepliesCard inboxStyleCardShown />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({ description: message }),
    );
    expect(mocks.dismissHint).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
  });

  it("goes for good on Not now", () => {
    render(<DraftRepliesCard inboxStyleCardShown />);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(mocks.dismissHint).toHaveBeenCalledWith({
      hintId: "draft-replies:ea_1",
    });
    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });
});
