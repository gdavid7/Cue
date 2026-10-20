// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayWeatherLocation } from "@/utils/actions/today-weather.validation";
import { TodayWeather } from "./TodayWeather";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  initial: null as TodayWeatherLocation | null,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account" }),
}));
vi.mock("@/utils/actions/today-weather", () => ({
  saveTodayWeatherAction: mocks.save,
}));
vi.mock("@/hooks/useUser", () => ({
  // A stand-in for SWR's cache of /api/user/me: local mutations apply.
  useUser: () => {
    const [data, setData] = useState({
      id: "user",
      todayWeather: mocks.initial,
    });
    return {
      data,
      mutate: (next?: typeof data) => {
        if (next) setData(next);
      },
    };
  },
}));

const FORECAST = {
  current: { temperature_2m: 17.6, weather_code: 2 },
  daily: { temperature_2m_max: [21.2], temperature_2m_min: [11.8] },
};

describe("TodayWeather", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.initial = null;
    mocks.save.mockResolvedValue({ data: { success: true } });
    fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return json({
          results: [{ name: "Paris", latitude: 48.853_41, longitude: 2.3488 }],
        });
      }
      if (url.hostname === "api.open-meteo.com") return json(FORECAST);
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "language", {
      value: "en-GB",
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is off until the user turns it on, and asks nothing of the browser or network", () => {
    const getCurrentPosition = stubGeolocation();

    renderWeather();

    expect(screen.getByRole("button", { name: "Show weather" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("a typed city: finds it, stores only a rounded location, and shows the weather", async () => {
    renderWeather();

    fireEvent.click(screen.getByRole("button", { name: "Show weather" }));
    fireEvent.change(screen.getByRole("textbox", { name: "City" }), {
      target: { value: "Paris" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        location: { latitude: 48.9, longitude: 2.3, label: "Paris" },
      }),
    );
    const trigger = await screen.findByRole("button", { name: /^18°/ });
    expect(trigger.textContent).toContain("Partly cloudy");
    expect(trigger.textContent).toContain("H 21° L 12°");
    expect(trigger.textContent).toContain("Paris");
    // The forecast is asked for with the coarse location, in Celsius here.
    const forecast = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(forecast.searchParams.get("latitude")).toBe("48.9");
    expect(forecast.searchParams.get("longitude")).toBe("2.3");
    expect(forecast.searchParams.get("temperature_unit")).toBe("celsius");
  });

  it("my location: asks the browser only on request, and stores it rounded", async () => {
    const getCurrentPosition = stubGeolocation({
      latitude: 37.774_929,
      longitude: -122.419_416,
    });
    Object.defineProperty(navigator, "language", {
      value: "en-US",
      configurable: true,
    });
    renderWeather();

    fireEvent.click(screen.getByRole("button", { name: "Show weather" }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        location: { latitude: 37.8, longitude: -122.4 },
      }),
    );
    await screen.findByText("H 21° L 12°");
    const forecast = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(forecast.searchParams.get("temperature_unit")).toBe("fahrenheit");
  });

  it("location refused: says so and offers a city instead, storing nothing", async () => {
    stubGeolocation(null);
    renderWeather();

    fireEvent.click(screen.getByRole("button", { name: "Show weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't get your location. Type a city instead.",
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("weather service down: fails quietly, and can still be turned off", async () => {
    mocks.initial = { latitude: 48.9, longitude: 2.3, label: "Paris" };
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderWeather();

    const trigger = await screen.findByRole("button", { name: "Paris" });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Turn off weather" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ location: null }),
    );
    expect(
      await screen.findByRole("button", { name: "Show weather" }),
    ).toBeTruthy();
  });
});

function renderWeather() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TodayWeather />
    </SWRConfig>,
  );
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A browser location: a position, a refusal (null), or none asked for. */
function stubGeolocation(
  coords: { latitude: number; longitude: number } | null = null,
) {
  const getCurrentPosition = vi.fn(
    (success: PositionCallback, failure?: PositionErrorCallback | null) => {
      if (coords) success({ coords } as GeolocationPosition);
      else failure?.({ code: 1 } as GeolocationPositionError);
    },
  );
  Object.defineProperty(navigator, "geolocation", {
    value: { getCurrentPosition },
    configurable: true,
  });
  return getCurrentPosition;
}
