// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_VISIT_EVERY_MS,
  resetRecordVisitForTesting,
} from "@/utils/user/record-visit";
import { VisitRecorder } from "./VisitRecorder";

const mocks = vi.hoisted(() => ({
  recordVisitAction: vi.fn(),
  user: { id: "user-1" } as { id: string } | undefined,
}));
vi.mock("@/utils/actions/away-summary", () => ({
  recordVisitAction: mocks.recordVisitAction,
}));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({ data: mocks.user }),
}));

const STORAGE_KEY = "cue:visit-recorded-at:user-1";
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
  localStorage.clear();
  resetRecordVisitForTesting();
  mocks.user = { id: "user-1" };
  mocks.recordVisitAction
    .mockReset()
    .mockResolvedValue({ data: { returned: false } });
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VisitRecorder", () => {
  it("records on load, then while the user works in the app, every ten minutes at most", async () => {
    render(<VisitRecorder />);
    await settle();
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);

    // Clicking around Mail a minute later changes nothing yet.
    vi.setSystemTime(Date.now() + 60_000);
    fireEvent.pointerDown(window);
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);

    // Still working after ten minutes: recorded again, so hours in Mail
    // never look like a break when Today opens.
    vi.setSystemTime(Date.now() + RECORD_VISIT_EVERY_MS);
    fireEvent.keyDown(window, { key: "j" });
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(2);
  });

  it("records when the tab comes back into view, not while it's hidden", async () => {
    render(<VisitRecorder />);
    await settle();
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000);

    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);

    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(2);
  });

  it("shares the ten minutes with this user's other tabs, not another user's", async () => {
    localStorage.setItem(STORAGE_KEY, String(Date.now() - 60_000));
    const { unmount } = render(<VisitRecorder />);
    await settle();
    expect(mocks.recordVisitAction).not.toHaveBeenCalled();
    unmount();

    mocks.user = { id: "user-2" };
    render(<VisitRecorder />);
    await settle();
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);
  });

  it("tries again on the next input when recording failed", async () => {
    mocks.recordVisitAction.mockResolvedValueOnce({ serverError: "Offline" });
    render(<VisitRecorder />);
    await settle();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.pointerDown(window);
    await settle();
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(Date.now()));
  });

  it("reloads While you were away on a return, so a Today left open overnight shows it on the first click", async () => {
    const loadAway = vi.fn().mockResolvedValue({ since: null });
    const loadOther = vi.fn().mockResolvedValue({});
    function Today() {
      useSWR("/api/user/home/away?accounts=a", loadAway);
      useSWR("/api/user/home?tz=UTC", loadOther);
      return null;
    }
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <VisitRecorder />
        <Today />
      </SWRConfig>,
    );
    await waitFor(() => expect(loadAway).toHaveBeenCalledTimes(1));
    await settle();

    // The next morning, the first click is a return.
    vi.setSystemTime(Date.now() + 14 * 60 * 60_000);
    mocks.recordVisitAction.mockResolvedValueOnce({ data: { returned: true } });
    fireEvent.pointerDown(window);

    await waitFor(() => expect(loadAway).toHaveBeenCalledTimes(2));
    expect(loadOther).toHaveBeenCalledTimes(1);
  });
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
