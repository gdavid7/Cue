/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarInvitation } from "@/components/email-list/CalendarInvitation";

(globalThis as { React?: typeof React }).React = React;

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn(), isExecuting: false }),
}));
vi.mock("@/utils/actions/calendar-invitation", () => ({
  respondToCalendarInvitationAction: vi.fn(),
}));
vi.mock("@/utils/error", () => ({ getActionErrorMessage: vi.fn() }));
vi.mock("@/utils/user", () => ({ logOut: vi.fn() }));

const invitation = {
  uid: "invite-uid-1",
  title: "Project planning",
  organizer: "organizer@example.com",
  recurring: false,
  start: "2030-03-04T10:00:00.000Z",
  end: "2030-03-04T11:00:00.000Z",
  allDay: false,
  location: null,
  conferenceUrl: null,
  response: null,
  calendarSynced: true,
};

describe("CalendarInvitation conflict line", () => {
  afterEach(cleanup);

  it("names the first conflict and counts the rest", async () => {
    const requested = renderCard({
      conflicts: {
        status: "ok",
        conflicts: [
          conflict("Design review"),
          conflict("1:1 with Sam"),
          conflict("Hiring sync"),
        ],
      },
    });

    expect(
      await screen.findByText("Conflicts with Design review"),
    ).toBeTruthy();
    expect(screen.getByText("+2 more")).toBeTruthy();
    const url = new URL(requested.find(isConflictsUrl)!, "http://localhost");
    expect(url.searchParams.get("start")).toBe(invitation.start);
    expect(url.searchParams.get("end")).toBe(invitation.end);
    expect(url.searchParams.get("uid")).toBe("invite-uid-1");
  });

  it("is free when the only overlap is the invitation's own copy", async () => {
    renderCard({
      conflicts: {
        status: "ok",
        conflicts: [conflict("Project planning")],
      },
    });

    expect(await screen.findByText("You’re free then")).toBeTruthy();
  });

  it("shows nothing when no calendar is connected", async () => {
    const requested = renderCard({ conflicts: { status: "no-calendar" } });

    await waitFor(() => expect(requested.some(isConflictsUrl)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Conflicts with|free then/)).toBeNull();
  });

  it("doesn't check all-day invitations", async () => {
    const requested = renderCard({
      invitation: {
        ...invitation,
        start: "2030-03-04",
        end: "2030-03-05",
        allDay: true,
      },
      conflicts: { status: "ok", conflicts: [] },
    });

    await screen.findByText("Project planning");
    expect(requested.some(isConflictsUrl)).toBe(false);
    expect(screen.queryByText("You’re free then")).toBeNull();
  });
});

function renderCard({
  invitation: shown = invitation,
  conflicts,
}: {
  invitation?: typeof invitation;
  conflicts: unknown;
}) {
  const requested: string[] = [];
  const fetcher = async (key: string | readonly [string, string]) => {
    const url = typeof key === "string" ? key : key[0];
    requested.push(url);
    if (isConflictsUrl(url)) return conflicts;
    return { invitation: shown };
  };
  render(
    <SWRConfig
      value={{ fetcher, provider: () => new Map(), dedupingInterval: 0 }}
    >
      <CalendarInvitation messageId="message-1" />
    </SWRConfig>,
  );
  return requested;
}

function isConflictsUrl(url: string) {
  return url.startsWith("/api/user/calendar/conflicts?");
}

function conflict(title: string) {
  return { title, start: invitation.start, end: invitation.end };
}
