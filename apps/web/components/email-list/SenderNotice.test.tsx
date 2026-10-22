// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SenderHistory } from "@inboxzero/mail-core/queries";
import { SenderNotice } from "@/components/email-list/SenderNotice";
import { PersonCardScope } from "@/components/person-card/PersonCard";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";

const mocks = vi.hoisted(() => ({
  querySenderHistory: vi.fn(),
  queryPersonCard: vi.fn(),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    querySenderHistory: mocks.querySenderHistory,
    queryPersonCard: mocks.queryPersonCard,
  }),
}));
vi.mock("@/hooks/useOwnEmailAddresses", () => ({
  useOwnEmailAddresses: () => OWN,
}));
vi.mock("@/utils/mail-engine/active-client", () => ({
  getActiveMailClient: () => null,
}));
vi.mock("@/utils/user", () => ({ logOut: vi.fn() }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "a" }),
}));
vi.mock("@/utils/attachments/download", () => ({
  getAttachmentUrl: () => "",
}));
vi.mock("@/components/email-list/EmailAttachments", () => ({
  AttachmentPreviewDialogContent: () => null,
}));
vi.mock("@/providers/ComposeModalProvider", () => ({
  useComposeModal: () => ({ composeTo: vi.fn() }),
}));

const OWN = ["me@example.com"];
const FAMILIAR = "Dana Example <dana.example@other.test>";

beforeEach(() => {
  resetBrowserCacheForTesting();
  window.localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  mocks.querySenderHistory.mockResolvedValue(
    history({ sameNameAddresses: ["dana@example.com"] }),
  );
  mocks.queryPersonCard.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SenderNotice", () => {
  it("says where a familiar name usually writes from, and opens their card", async () => {
    renderNotice(FAMILIAR);

    expect(
      await screen.findByText(
        "Dana Example usually writes from dana@example.com. This message is from dana.example@other.test.",
      ),
    ).toBeTruthy();
    expect(mocks.querySenderHistory).toHaveBeenCalledWith({
      accountIds: ["a"],
      email: "dana.example@other.test",
      name: "Dana Example",
      ownAddresses: OWN,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show contact" }));
    await waitFor(() =>
      expect(mocks.queryPersonCard).toHaveBeenCalledWith(
        expect.objectContaining({ email: "dana@example.com" }),
      ),
    );
  });

  it("asks again while the contact index is still being built", async () => {
    mocks.querySenderHistory
      .mockResolvedValueOnce(history({ ready: false }))
      .mockResolvedValue(history({ sameNameAddresses: ["dana@example.com"] }));
    renderNotice(FAMILIAR);

    expect(
      await screen.findByTestId("sender-notice", undefined, { timeout: 8000 }),
    ).toBeTruthy();
    expect(mocks.querySenderHistory).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("stays hidden for that name and address once marked fine, after a remount too", async () => {
    const { unmount } = renderNotice(FAMILIAR);
    fireEvent.click(await screen.findByRole("button", { name: "It's fine" }));
    expect(screen.queryByTestId("sender-notice")).toBeNull();
    unmount();

    renderNotice(FAMILIAR);
    // Nothing to look up for an allowed pair.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("sender-notice")).toBeNull();
    expect(mocks.querySenderHistory).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a sender you have written to", async () => {
    mocks.querySenderHistory.mockResolvedValue(
      history({ writtenTo: true, sameNameAddresses: ["dana@example.com"] }),
    );
    renderNotice(FAMILIAR);
    await waitFor(() => expect(mocks.querySenderHistory).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("sender-notice")).toBeNull();
  });

  it("flags an address-like name on another domain without a lookup", () => {
    renderNotice('"billing@bank.example" <alerts@lookalike.test>');
    expect(
      screen.getByText(
        "The name on this message is billing@bank.example, but it is from alerts@lookalike.test.",
      ),
    ).toBeTruthy();
    expect(mocks.querySenderHistory).not.toHaveBeenCalled();
  });
});

function renderNotice(from: string) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PersonCardScope
        value={{
          accountIds: ["a"],
          ownAddresses: OWN,
          replyTracking: [],
          openConversation: null,
          onOpenConversation: vi.fn(),
        }}
      >
        <SenderNotice emailAccountId="a" from={from} />
      </PersonCardScope>
    </SWRConfig>,
  );
}

function history(input: Partial<SenderHistory> = {}): SenderHistory {
  return { ready: true, writtenTo: false, sameNameAddresses: [], ...input };
}
