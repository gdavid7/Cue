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
import { TodayWeather } from "@/app/(app)/[emailAccountId]/home/TodayWeather";
import { TodayWeatherSetting } from "@/app/(app)/settings/TodayWeatherSetting";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  toastError: vi.fn(),
  user: {} as Record<string, unknown>,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account" }),
}));
vi.mock("@/utils/actions/today-weather", () => ({
  saveTodayWeatherAction: mocks.save,
}));
vi.mock("@/components/Toast", () => ({ toastError: mocks.toastError }));

describe("TodayWeatherSetting", () => {
  beforeEach(() => {
    mocks.user = {
      id: "user",
      todayWeather: null,
      todayWeatherDismissed: true,
    };
    mocks.save.mockResolvedValue({ data: { success: true } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No network in this test");
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("after Not now, turning it on brings the offer back to Today", async () => {
    renderWithToday();

    const toggle = await screen.findByRole("switch", {
      name: "Weather on Today",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show weather" })).toBeNull();

    fireEvent.click(toggle);

    expect(
      await screen.findByRole("button", { name: "Show weather" }),
    ).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The same setting "Not now" wrote, cleared: no second flag.
    expect(mocks.save).toHaveBeenCalledWith({
      location: null,
      dismissed: false,
    });
  });

  it("turning it off removes the location and stops the offer", async () => {
    mocks.user = {
      id: "user",
      todayWeather: { latitude: 48.9, longitude: 2.3, label: "Paris" },
      todayWeatherDismissed: false,
    };
    renderWithToday();

    fireEvent.click(
      await screen.findByRole("switch", { name: "Weather on Today" }),
    );

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        location: null,
        dismissed: true,
      }),
    );
    expect(screen.queryByRole("button", { name: "Paris" })).toBeNull();
  });

  it("a save that fails is undone and says so", async () => {
    mocks.save.mockResolvedValue({ serverError: "Nope" });
    renderWithToday();

    const toggle = await screen.findByRole("switch", {
      name: "Weather on Today",
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });
});

/** Settings and Today side by side, sharing the user's settings as in the app. */
function renderWithToday() {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        fetcher: async () => ({ ...mocks.user }),
      }}
    >
      <TodayWeatherSetting />
      <TodayWeather />
    </SWRConfig>,
  );
}
