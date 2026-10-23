// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetAwaySummaryResponse } from "@/app/api/user/home/away/route";
import { sinceLabel, WhileYouWereAway } from "./WhileYouWereAway";

vi.mock("@/utils/actions/away-summary", () => ({
  dismissAwaySummaryAction: vi.fn(),
  recordVisitAction: vi.fn(),
}));

const SINCE = "2026-10-22T18:00:00.000Z";
const UNTIL = "2026-10-23T08:00:00.000Z";
const WINDOW = { until: UNTIL, lastVisitAt: SINCE };

afterEach(cleanup);

describe("WhileYouWereAway", () => {
  it("says what Cue did, each count opening History filtered to it", () => {
    renderCard({
      since: SINCE,
      ...WINDOW,
      capped: false,
      accounts: [{ emailAccountId: "a", sorted: 12, archived: 8, drafted: 3 }],
    });

    expect(
      screen.getByRole("region", { name: "While you were away" }),
    ).toBeTruthy();
    expect(screen.getByText(/Cue/, { selector: "p" }).textContent).toMatch(
      /, Cue sorted 12 emails, archived 8 and drafted 3 replies\.$/,
    );
    expect(
      screen.getByRole("link", { name: "archived 8" }).getAttribute("href"),
    ).toBe(
      `/a/automation?tab=history&action=archived&since=${encodeURIComponent(SINCE)}&until=${encodeURIComponent(UNTIL)}&automated=1`,
    );
    expect(
      screen
        .getByRole("link", { name: "drafted 3 replies" })
        .getAttribute("href"),
    ).toContain("/a/automation?tab=history&action=drafted&");
  });

  it("leaves out what Cue didn't do, and hides when it did nothing", () => {
    const { rerender } = renderCard({
      since: SINCE,
      ...WINDOW,
      capped: false,
      accounts: [{ emailAccountId: "a", sorted: 0, archived: 1, drafted: 0 }],
    });
    expect(screen.getByRole("link").textContent).toBe("archived 1 email");

    rerender(
      <WhileYouWereAway
        accountColorIndexById={{}}
        onDismiss={vi.fn()}
        summary={{
          since: SINCE,
          ...WINDOW,
          capped: false,
          accounts: [
            { emailAccountId: "a", sorted: 0, archived: 0, drafted: 0 },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("across accounts sums them, with each account's counts opening its own History", () => {
    renderCard(
      {
        since: SINCE,
        ...WINDOW,
        capped: false,
        accounts: [
          { emailAccountId: "a", sorted: 2, archived: 1, drafted: 0 },
          { emailAccountId: "b", sorted: 3, archived: 0, drafted: 1 },
          { emailAccountId: "c", sorted: 0, archived: 0, drafted: 0 },
        ],
      },
      [
        { id: "a", email: "me@work.example" },
        { id: "b", email: "me@home.example" },
        { id: "c", email: "me@old.example" },
      ],
    );

    expect(screen.getByText(/Cue/, { selector: "p" }).textContent).toMatch(
      /Cue sorted 5 emails, archived 1 and drafted 1 reply\.$/,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen
        .getByRole("link", { name: "sorted 3 emails" })
        .getAttribute("href"),
    ).toContain("/b/automation?tab=history&action=sorted&");
    expect(screen.queryByText("me@old.example")).toBeNull();
  });

  it("can be dismissed", () => {
    const onDismiss = vi.fn();
    renderCard(
      {
        since: SINCE,
        ...WINDOW,
        capped: false,
        accounts: [{ emailAccountId: "a", sorted: 1, archived: 0, drafted: 0 }],
      },
      undefined,
      onDismiss,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("sinceLabel", () => {
  const now = new Date(2026, 9, 23, 9, 0);
  it.each([
    [new Date(2026, 9, 23, 7, 0), false, "Since earlier today"],
    [new Date(2026, 9, 22, 18, 0), false, "Since yesterday"],
    [new Date(2026, 9, 19, 18, 0), false, "Since Monday"],
    [new Date(2026, 9, 16, 9, 0), true, "In the last week"],
  ])("%s", (since, capped, label) => {
    expect(sinceLabel(since, capped, now)).toBe(label);
  });
});

function renderCard(
  summary: GetAwaySummaryResponse,
  accounts?: { id: string; email: string }[],
  onDismiss = vi.fn(),
) {
  return render(
    <WhileYouWereAway
      accountColorIndexById={{ a: 0, b: 1, c: 2 }}
      accounts={accounts}
      onDismiss={onDismiss}
      summary={summary}
    />,
  );
}
