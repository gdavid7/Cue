// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { DraftEmailStatus } from "@/generated/prisma/enums";
import { getInboxStyleHintId } from "@/utils/split-inbox/inbox-styles";
import AdminBetaTestersPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: { ADMINS: ["founder@example.com"] },
}));

const HOUR = 60 * 60 * 1000;

describe("/admin/beta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findMany.mockResolvedValue([]);
    prisma.calendarConnection.groupBy.mockResolvedValue([] as never);
    prisma.chat.groupBy.mockResolvedValue([] as never);
    prisma.executedRule.groupBy.mockResolvedValue([] as never);
    prisma.executedAction.findMany.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access and reads nothing when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminBetaTestersPage();

    expect(page.props.title).toBe("No Access");
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("shows each tester's activity, sync health, progress and suggestions", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });
    const now = Date.now();
    prisma.user.findMany.mockResolvedValue([
      {
        id: "friend",
        email: "friend@example.com",
        name: "Friend",
        createdAt: new Date(now - 2 * 24 * HOUR),
        lastLogin: new Date(now - 3 * HOUR),
        dismissedHints: [getInboxStyleHintId("acc")],
        errorMessages: null,
        emailAccounts: [
          {
            id: "acc",
            watchEmailsExpirationDate: new Date(now - HOUR),
            account: { provider: "google", disconnectedAt: null },
          },
        ],
      },
    ] as never);
    prisma.executedRule.groupBy.mockImplementation((async (args: {
      where: { status: unknown };
    }) =>
      args.where.status === "ERROR"
        ? [{ emailAccountId: "acc", _count: { _all: 2 } }]
        : args.where.status
          ? [
              {
                emailAccountId: "acc",
                _max: { createdAt: new Date(now - 5 * HOUR) },
              },
            ]
          : []) as never);
    prisma.chat.groupBy.mockResolvedValue([{ emailAccountId: "acc" }] as never);
    prisma.executedAction.findMany.mockResolvedValue([
      {
        draftStatus: DraftEmailStatus.LIKELY_SENT,
        replySuggestionShownAt: new Date(),
        executedRule: { emailAccountId: "acc" },
      },
      {
        draftStatus: DraftEmailStatus.PENDING,
        replySuggestionShownAt: new Date(),
        executedRule: { emailAccountId: "acc" },
      },
    ] as never);

    render(await AdminBetaTestersPage());

    const row = screen.getByText("Friend").closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual([
      "Friendfriend@example.comJoined 2d ago",
      "3h ago",
      "1 (google)",
      "5h ago",
      "2",
      "watch expired",
      "2/6",
      "2",
      "1",
    ]);
  });
});
