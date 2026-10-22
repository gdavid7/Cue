// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PersonCard,
  PersonCardConversation,
} from "@inboxzero/mail-core/queries";
import type { GetCalendarTodayEventsResponse } from "@/app/api/user/calendar/upcoming-events/route";
import { YourDay } from "./YourDay";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-22T10:00:00.000Z");

const mocks = vi.hoisted(() => ({
  queryPersonCard: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({ queryPersonCard: mocks.queryPersonCard }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "a" }),
}));
vi.mock("@/hooks/useOwnEmailAddresses", () => ({
  useOwnEmailAddresses: () => ["me@example.com"],
}));
vi.mock("@/hooks/useLabels", () => ({
  useLabels: () => ({ userLabels: [] }),
}));
vi.mock("@/utils/mail-engine/active-client", () => ({
  getActiveMailClient: () => null,
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
  mocks.queryPersonCard.mockImplementation(
    async ({ email }: { email: string }) => card(email, []),
  );
});

afterEach(async () => {
  // Card reads still on their way land before the test's cache goes.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("YourDay", () => {
  it("lists each meeting with its time, title and the people on it", () => {
    renderDay([
      meeting({
        id: "review",
        title: "Design review",
        startTime: inHours(4),
        attendees: [
          { email: "ana@partner.com", name: "Ana Silva" },
          { email: "ben@partner.com" },
          { email: "cy@partner.com", name: "Cy" },
          { email: "dee@partner.com", name: "Dee" },
          { email: "eli@partner.com", name: "Eli" },
        ],
      }),
    ]);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Design review")).toBeTruthy();
    expect(within(row).getByText(formatTime(inHours(4)))).toBeTruthy();
    // Named people by name, the rest by address, three at most.
    expect(within(row).getByRole("button", { name: "Ana Silva" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "ben" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Cy" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Dee" })).toBeNull();
    expect(within(row).getByText("+2")).toBeTruthy();
  });

  it("marks the meeting going on now, and says how many more the day has", () => {
    renderDay(
      [
        meeting({
          id: "standup",
          title: "Standup",
          startTime: inHours(-0.25),
          endTime: inHours(0.25),
        }),
      ],
      { more: 3 },
    );

    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getByText("3 more today")).toBeTruthy();
  });

  it("says whose calendar a meeting is on when there are two", () => {
    renderDay([
      meeting({ title: "Standup", calendarEmail: "me@work.example" }),
    ]);

    expect(
      within(screen.getByRole("listitem")).getByText("me@work.example"),
    ).toBeTruthy();
  });

  it("shows nothing on a day without meetings", () => {
    const { container } = renderDay([]);

    expect(container.textContent).toBe("");
    expect(mocks.queryPersonCard).not.toHaveBeenCalled();
  });

  it("opens the person card from an attendee chip", async () => {
    renderDay([
      meeting({ attendees: [{ email: "ana@partner.com", name: "Ana Silva" }] }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Ana Silva" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("heading", { name: "Ana Silva" }),
    ).toBeTruthy();
    expect(within(dialog).getByText("ana@partner.com")).toBeTruthy();
  });

  it("names the latest conversation with the meeting's people, from this device's mail", async () => {
    mocks.queryPersonCard.mockImplementation(
      async ({ email }: { email: string }) =>
        card(
          email,
          email === "ana@partner.com"
            ? [
                conversation("ana-only", "Lunch?", inHours(-1)),
                conversation("shared", "Q3 plan", inHours(-48)),
              ]
            : [conversation("shared", "Q3 plan", inHours(-48))],
        ),
    );

    renderDay([
      meeting({
        attendees: [
          { email: "ana@partner.com", name: "Ana Silva" },
          { email: "ben@partner.com", name: "Ben" },
        ],
      }),
    ]);

    // The conversation with both of them beats a newer one with only one.
    const link = await screen.findByRole("link", { name: /Q3 plan/ });
    expect(link.getAttribute("href")).toBe("/thread/shared");
    expect(screen.queryByText("Lunch?")).toBeNull();
    // Read with the card's own query, from the local store only.
    expect(mocks.queryPersonCard).toHaveBeenCalledWith({
      accountIds: ["a"],
      email: "ana@partner.com",
      ownAddresses: ["me@example.com"],
      replyTracking: [
        { accountId: "a", toReplyLabelId: null, awaitingReplyLabelId: null },
      ],
    });
  });

  it("leaves the line out when there's no mail with them", async () => {
    renderDay([
      meeting({ attendees: [{ email: "new@partner.com", name: "New" }] }),
    ]);

    await waitFor(() => expect(mocks.queryPersonCard).toHaveBeenCalled());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

type DayEvent = GetCalendarTodayEventsResponse["events"][number];

function renderDay(events: DayEvent[], { more = 0 } = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <YourDay
        events={events}
        layout="list"
        more={more}
        now={NOW}
        threadHref={({ threadId }) => `/thread/${threadId}`}
      />
    </SWRConfig>,
  );
}

function meeting(overrides: Partial<DayEvent>): DayEvent {
  const startTime = overrides.startTime ?? inHours(2);
  return {
    id: "meeting",
    title: "Meeting",
    startTime,
    endTime: new Date(new Date(startTime).getTime() + HOUR / 2).toISOString(),
    attendees: [],
    ...overrides,
  };
}

function conversation(
  conversationId: string,
  subject: string,
  at: string,
): PersonCardConversation {
  return {
    accountId: "a",
    conversationId,
    subject,
    latestMessageAtMs: new Date(at).getTime(),
  };
}

function card(
  email: string,
  conversations: PersonCardConversation[],
): PersonCard {
  return {
    email,
    automated: false,
    name: null,
    otherAddresses: [],
    conversations,
    files: [],
    replyLag: { theirs: null, yours: null },
    awaitingYou: [],
    awaitingThem: [],
    history: { syncing: false, sinceMs: null },
  };
}

function inHours(hours: number) {
  return new Date(NOW.getTime() + hours * HOUR).toISOString();
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
