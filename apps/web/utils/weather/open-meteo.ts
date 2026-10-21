import { z } from "zod";
import type { TodayWeatherLocation } from "@/utils/actions/today-weather.validation";

// Open-Meteo is free and needs no key. It is called from the browser only, so
// the user's location never passes through Cue's servers.
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const TIMEOUT_MS = 5000;

export type TemperatureUnit = "celsius" | "fahrenheit";

const forecastSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    weather_code: z.number(),
  }),
  daily: z.object({
    temperature_2m_max: z.array(z.number()).min(1),
    temperature_2m_min: z.array(z.number()).min(1),
  }),
});

const geocodingSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
      }),
    )
    .optional(),
});

export type Weather = {
  temperature: number;
  high: number;
  low: number;
  code: number;
};

/** Now and today's high and low where the user said they are. */
export async function fetchWeather(
  { latitude, longitude }: TodayWeatherLocation,
  unit: TemperatureUnit,
): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min",
    temperature_unit: unit,
    timezone: "auto",
    forecast_days: "1",
  });
  const { current, daily } = forecastSchema.parse(
    await getJson(`${FORECAST_URL}?${params}`),
  );
  return {
    temperature: Math.round(current.temperature_2m),
    high: Math.round(daily.temperature_2m_max[0]),
    low: Math.round(daily.temperature_2m_min[0]),
    code: current.weather_code,
  };
}

/** The best match for a city the user typed, or null when there's none. */
export async function findCity(
  name: string,
): Promise<TodayWeatherLocation | null> {
  const params = new URLSearchParams({
    name: name.trim(),
    count: "1",
    format: "json",
  });
  const { results } = geocodingSchema.parse(
    await getJson(`${GEOCODING_URL}?${params}`),
  );
  const city = results?.[0];
  if (!city) return null;
  return {
    latitude: city.latitude,
    longitude: city.longitude,
    label: city.name,
  };
}

/** Fahrenheit where people read it, Celsius elsewhere. */
export function temperatureUnitFor(locale: string): TemperatureUnit {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region && FAHRENHEIT_REGIONS.has(region) ? "fahrenheit" : "celsius";
  } catch {
    return "celsius";
  }
}

/** A word or two for a WMO weather code, as Open-Meteo reports it. */
export function describeWeather(code: number): {
  label: string;
  kind: WeatherKind;
} {
  if (code === 0) return { label: "Clear", kind: "clear" };
  if (code <= 2) return { label: "Partly cloudy", kind: "partly" };
  if (code === 3) return { label: "Cloudy", kind: "cloudy" };
  if (code <= 48) return { label: "Fog", kind: "fog" };
  if (code <= 57) return { label: "Drizzle", kind: "rain" };
  if (code <= 67) return { label: "Rain", kind: "rain" };
  if (code <= 77) return { label: "Snow", kind: "snow" };
  if (code <= 82) return { label: "Showers", kind: "rain" };
  if (code <= 86) return { label: "Snow showers", kind: "snow" };
  return { label: "Thunderstorms", kind: "storm" };
}

export type WeatherKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "storm";

const FAHRENHEIT_REGIONS = new Set(["US", "BS", "BZ", "KY", "LR", "PW"]);

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Nothing identifying goes with it.
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok)
    throw new Error(`Weather service answered ${response.status}`);
  return response.json();
}
