/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import { formatSnoozeTime } from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(
  globalThis as unknown as { ResizeObserver?: typeof MockResizeObserver }
).ResizeObserver = MockResizeObserver;

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

describe("SnoozeButton calendar presets", () => {
  it("asks the conversation's own account only once the picker opens", async () => {
    const meetingEnds = new Date(Date.now() + 2 * HOUR);
    const freeHour = new Date(Date.now() + 3 * HOUR);
    const fetcher = vi.fn(async () => ({
      afterNextMeeting: meetingEnds.toISOString(),
      nextFreeHour: freeHour.toISOString(),
    }));
    const onSnooze = vi.fn();
    renderPicker({ fetcher, onSnooze });

    expect(fetcher).not.toHaveBeenCalled();
    openPicker();

    const afterMeeting = await screen.findByRole("button", {
      name: new RegExp(
        `^After my next meeting${formatSnoozeTime(meetingEnds)}`,
      ),
    });
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^Next free hour${formatSnoozeTime(freeHour)}`),
      }),
    ).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith([
      "/api/user/calendar/snooze-times",
      "account-2",
    ]);
    // Below the clock presets and the date and time row.
    const names = buttonNames();
    expect(
      names.findIndex((name) => name.startsWith("After my next meeting")),
    ).toBeGreaterThan(
      names.findIndex((name) => name.startsWith("Choose date and time")),
    );

    fireEvent.click(afterMeeting);
    expect(onSnooze).toHaveBeenCalledWith(meetingEnds);
  });

  it("keeps the clock presets where they are when calendar times arrive", async () => {
    let answer: (times: unknown) => void = () => {};
    renderPicker({
      fetcher: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    openPicker();
    await screen.findByRole("button", { name: /^Tomorrow/ });
    const before = buttonNames();

    answer({
      afterNextMeeting: new Date(Date.now() + 2 * HOUR).toISOString(),
      nextFreeHour: new Date(Date.now() + 3 * HOUR).toISOString(),
    });
    await screen.findByRole("button", { name: /^After my next meeting/ });

    expect(buttonNames().slice(0, before.length)).toEqual(before);
  });

  it("starts reading when the pointer reaches the trigger", async () => {
    const fetcher = vi.fn(async () => ({
      afterNextMeeting: null,
      nextFreeHour: null,
    }));
    renderPicker({ fetcher });

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Snooze" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it("shows only the time the calendar could work out", async () => {
    const freeHour = new Date(Date.now() + HOUR);
    renderPicker({
      fetcher: async () => ({
        afterNextMeeting: null,
        nextFreeHour: freeHour.toISOString(),
      }),
    });
    openPicker();

    await screen.findByRole("button", { name: /^Next free hour/ });
    expect(
      screen.queryByRole("button", { name: /^After my next meeting/ }),
    ).toBeNull();
  });

  it("leaves out a time that has already passed", async () => {
    renderPicker({
      fetcher: async () => ({
        afterNextMeeting: new Date(Date.now() - HOUR).toISOString(),
        nextFreeHour: null,
      }),
    });
    openPicker();

    await screen.findByRole("button", { name: /^Tomorrow/ });
    await settle();
    expect(
      screen.queryByRole("button", { name: /^After my next meeting/ }),
    ).toBeNull();
  });

  it("shows only the usual presets while loading and when the calendar fails", async () => {
    let fail: (error: Error) => void = () => {};
    renderPicker({
      fetcher: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    });
    openPicker();

    expect(screen.getByRole("button", { name: /^Tomorrow/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^After my next meeting/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Next free hour/ }),
    ).toBeNull();

    fail(new Error("Could not read your calendar"));
    await settle();
    expect(
      screen.queryByRole("button", { name: /^After my next meeting/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Next free hour/ }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function renderPicker({
  fetcher,
  onSnooze = vi.fn(),
}: {
  fetcher: (key: unknown) => Promise<unknown>;
  onSnooze?: (until: Date) => void;
}) {
  render(
    <SWRConfig
      value={{ provider: () => new Map(), fetcher, dedupingInterval: 0 }}
    >
      <SnoozeButton emailAccountId="account-2" onSnooze={onSnooze} />
    </SWRConfig>,
  );
}

function buttonNames() {
  return screen
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
}

async function settle() {
  await waitFor(() => new Promise((resolve) => setTimeout(resolve, 0)));
}
