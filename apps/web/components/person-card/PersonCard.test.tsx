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
import type { ImportantPerson } from "@inboxzero/mail-core/important-people";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { PersonCard as PersonCardData } from "@inboxzero/mail-core/queries";
import { MAIL_SHORTCUTS_OFF_ATTRIBUTE } from "@/lib/shortcuts/registry";
import { relayImportantPeopleChanges } from "@/utils/mail-engine/important-people-changes";
import { createMemoryTabBus } from "@/utils/mail-engine/tab-channel";
import {
  getComposeAccountId,
  PersonCardScope,
  PersonCardTrigger,
} from "@/components/person-card/PersonCard";

const HOUR = 3_600_000;
const mocks = vi.hoisted(() => ({
  queryPersonCard: vi.fn(),
  composeTo: vi.fn(),
  client: null as Partial<MailClient> | null,
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () =>
    mocks.client ?? { queryPersonCard: mocks.queryPersonCard },
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
  mocks.client = null;
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

  it("writes to them from the card, from the open message's account", async () => {
    renderTrigger();
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(mocks.composeTo).toHaveBeenCalledWith("ana@example.com", "a");
  });

  it("in All inboxes, writes from the account of your newest conversation with them", async () => {
    mocks.queryPersonCard.mockResolvedValue({
      ...card(),
      conversations: [
        { ...card().conversations[1], accountId: "b" },
        card().conversations[0],
      ],
    });
    renderTrigger({ accountIds: ["a", "b"], openConversation: null });
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(mocks.composeTo).toHaveBeenCalledWith("ana@example.com", "b");
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

describe("getComposeAccountId", () => {
  const newest = (accountId: string) => ({
    conversations: [
      {
        accountId,
        conversationId: "newest",
        subject: "",
        latestMessageAtMs: 1,
      },
    ],
  });

  it("uses the account of the message the card was opened from", () => {
    expect(
      getComposeAccountId(
        {
          accountIds: ["a", "b"],
          openConversation: { accountId: "b", conversationId: "open" },
        },
        newest("a"),
      ),
    ).toBe("b");
  });

  it("otherwise uses the account of the newest conversation with them", () => {
    expect(
      getComposeAccountId(
        { accountIds: ["a", "b"], openConversation: null },
        newest("b"),
      ),
    ).toBe("b");
  });

  it("keeps a single account's view on that account", () => {
    expect(
      getComposeAccountId(
        {
          accountIds: ["a"],
          openConversation: { accountId: "a", conversationId: "open" },
        },
        newest("a"),
      ),
    ).toBe("a");
  });

  it("never picks an account the card doesn't read from", () => {
    expect(
      getComposeAccountId(
        {
          accountIds: ["a"],
          openConversation: { accountId: "excluded", conversationId: "open" },
        },
        newest("excluded"),
      ),
    ).toBeUndefined();
  });

  it("leaves the choice to compose before anything is known", () => {
    expect(
      getComposeAccountId(
        { accountIds: ["a", "b"], openConversation: null },
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe("Important star", () => {
  it("stars someone in the card's account and unstars them again", async () => {
    const { stored, setImportantPerson } = engineWithStars();
    const bus = createMemoryTabBus();
    const toOtherTabs: unknown[] = [];
    bus.subscribe((message) => toOtherTabs.push(message));
    const stopRelay = relayImportantPeopleChanges(bus, vi.fn());
    renderTrigger();
    await openCard();

    const star = await screen.findByRole("button", { name: "Important" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(star);
    });

    expect(setImportantPerson).toHaveBeenCalledWith({
      accountIds: ["a"],
      email: "ana@example.com",
      important: true,
    });
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    expect(stored.map((person) => person.accountId)).toEqual(["a"]);

    await act(async () => {
      fireEvent.click(star);
    });
    await waitFor(() =>
      expect(star.getAttribute("aria-pressed")).toBe("false"),
    );
    expect(stored).toEqual([]);
    expect(toOtherTabs).toEqual([
      { type: "importantPeopleChanged" },
      { type: "importantPeopleChanged" },
    ]);
    stopRelay();
  });

  it("in All inboxes shows a star from any account and removes it from all of them", async () => {
    const { stored, setImportantPerson } = engineWithStars([
      { accountId: "b", email: "ana@example.com", addedAtMs: 1 },
    ]);
    renderTrigger({ accountIds: ["a", "b"] });
    await openCard();

    const star = await screen.findByRole("button", { name: "Important" });
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => {
      fireEvent.click(star);
    });

    expect(setImportantPerson).toHaveBeenCalledWith({
      accountIds: ["a", "b"],
      email: "ana@example.com",
      important: false,
    });
    expect(stored).toEqual([]);
  });

  it("closes the card on the first Escape while the star has focus", async () => {
    engineWithStars();
    renderTrigger();
    await openCard();

    const star = await screen.findByRole("button", { name: "Important" });
    star.focus();
    fireEvent.keyDown(star, { key: "Escape" });

    expect(screen.queryByTestId("person-card")).toBeNull();
  });

  it("is hidden when the engine doesn't keep stars", async () => {
    renderTrigger();
    await openCard();

    expect(screen.queryByRole("button", { name: "Important" })).toBeNull();
    expect(screen.getByText("Earlier plan")).toBeTruthy();
  });
});

function engineWithStars(people: ImportantPerson[] = []) {
  const stored = [...people];
  const setImportantPerson = vi.fn(
    async (input: {
      accountIds: string[];
      email: string;
      important: boolean;
    }) => {
      for (const accountId of input.accountIds) {
        const at = stored.findIndex(
          (person) =>
            person.accountId === accountId && person.email === input.email,
        );
        if (at >= 0) stored.splice(at, 1);
        if (input.important)
          stored.push({ accountId, email: input.email, addedAtMs: 1 });
      }
    },
  );
  mocks.client = {
    capabilities: [
      "method:queryPersonCard",
      "method:queryImportantPeople",
      "method:setImportantPerson",
    ],
    queryPersonCard: mocks.queryPersonCard,
    queryImportantPeople: async (accountIds: string[]) =>
      stored.filter((person) => accountIds.includes(person.accountId)),
    setImportantPerson,
  };
  return { stored, setImportantPerson };
}

function renderTrigger(
  scope: {
    onOpenConversation?: () => void;
    accountIds?: string[];
    openConversation?: { accountId: string; conversationId: string } | null;
  } = {},
  email = "ana@example.com",
) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PersonCardScope
        value={{
          accountIds: scope.accountIds ?? ["a"],
          ownAddresses: ["me@example.com"],
          replyTracking: [],
          openConversation:
            scope.openConversation === undefined
              ? { accountId: "a", conversationId: "open" }
              : scope.openConversation,
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
