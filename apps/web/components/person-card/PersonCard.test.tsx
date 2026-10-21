// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonCard as PersonCardData } from "@inboxzero/mail-core/queries";
import { MAIL_SHORTCUTS_OFF_ATTRIBUTE } from "@/lib/shortcuts/registry";
import {
  PersonCardScope,
  PersonCardTrigger,
} from "@/components/person-card/PersonCard";

const HOUR = 3_600_000;
const mocks = vi.hoisted(() => ({
  queryPersonCard: vi.fn(),
  composeTo: vi.fn(),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({ queryPersonCard: mocks.queryPersonCard }),
}));
vi.mock("@/utils/user", () => ({ logOut: vi.fn() }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "a" }),
}));
vi.mock("@/utils/attachments/download", () => ({
  getAttachmentUrl: () => "",
}));
vi.mock("@/utils/mail-engine/active-client", () => ({
  getActiveMailClient: () => null,
}));
vi.mock("@/components/email-list/EmailAttachments", () => ({
  AttachmentPreviewDialogContent: () => null,
}));
vi.mock("@/providers/ComposeModalProvider", () => ({
  useComposeModal: () => ({ composeTo: mocks.composeTo }),
}));

beforeEach(() => {
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
  mocks.queryPersonCard.mockResolvedValue(card());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PersonCardTrigger", () => {
  it("opens from the name with what is going on with them, without the open conversation", async () => {
    const onOpenConversation = vi.fn();
    renderTrigger({ onOpenConversation });

    await openCard();

    expect(mocks.queryPersonCard).toHaveBeenCalledWith({
      accountIds: ["a"],
      email: "ana@example.com",
      ownAddresses: ["me@example.com"],
      replyTracking: [],
    });
    expect(screen.getByRole("heading", { name: "Ana Lima" })).toBeTruthy();
    expect(screen.getByText("Also ana@work.example")).toBeTruthy();
    expect(screen.getByText("Earlier plan")).toBeTruthy();
    expect(screen.queryByText("Open now")).toBeNull();
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText("4 hours")).toBeTruthy();
    expect(screen.getByText("Still syncing older mail")).toBeTruthy();

    fireEvent.click(screen.getByText("Earlier plan"));

    expect(onOpenConversation).toHaveBeenCalledWith("a", "earlier");
    expect(screen.queryByTestId("person-card")).toBeNull();
  });

  it("closes on Escape and gives focus back to the name", async () => {
    renderTrigger();
    await openCard();
    expect(
      screen
        .getByTestId("person-card")
        .hasAttribute(MAIL_SHORTCUTS_OFF_ATTRIBUTE),
    ).toBe(true);

    fireEvent.keyDown(screen.getByTestId("person-card"), { key: "Escape" });
    expect(screen.queryByTestId("person-card")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Ana Lima" }),
      ),
    );
  });

  it("says the history isn't available when the engine can't read it", async () => {
    mocks.queryPersonCard.mockRejectedValue(
      new Error("unsupported method queryPersonCard"),
    );
    renderTrigger();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ana Lima" }));
    });
    expect(
      await screen.findByText(
        "Your mail history with them isn't available here.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New message" })).toBeTruthy();
  });

  it("writes to them from the card", async () => {
    renderTrigger();
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(mocks.composeTo).toHaveBeenCalledWith("ana@example.com");
  });

  it("is plain text for the user's own address and outside a reader", () => {
    renderTrigger({}, "me@example.com");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(
      <PersonCardTrigger email="ana@example.com" name="Ana Lima">
        Ana Lima
      </PersonCardTrigger>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

function renderTrigger(
  scope: { onOpenConversation?: () => void } = {},
  email = "ana@example.com",
) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PersonCardScope
        value={{
          accountIds: ["a"],
          ownAddresses: ["me@example.com"],
          replyTracking: [],
          openConversation: { accountId: "a", conversationId: "open" },
          onOpenConversation: scope.onOpenConversation ?? vi.fn(),
        }}
      >
        <PersonCardTrigger email={email} name="Ana Lima" sender>
          Ana Lima
        </PersonCardTrigger>
      </PersonCardScope>
    </SWRConfig>,
  );
}

async function openCard() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ana Lima" }));
  });
  expect(await screen.findByTestId("person-card")).toBeTruthy();
  await screen.findByText("Earlier plan");
}

function card(): PersonCardData {
  const conversation = (conversationId: string, subject: string) => ({
    accountId: "a",
    conversationId,
    subject,
    latestMessageAtMs: 1_800_000_000_000,
  });
  return {
    email: "ana@example.com",
    automated: false,
    name: "Ana Lima",
    otherAddresses: ["ana@work.example"],
    conversations: [
      conversation("open", "Open now"),
      conversation("earlier", "Earlier plan"),
    ],
    files: [],
    replyLag: { theirs: { medianMs: 4 * HOUR, exchanges: 3 }, yours: null },
    awaitingYou: [conversation("ask", "Question for you")],
    awaitingThem: [],
    history: { syncing: true, sinceMs: null },
  };
}
