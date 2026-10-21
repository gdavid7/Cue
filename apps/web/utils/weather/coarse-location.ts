import type { TodayWeatherLocation } from "@/utils/actions/today-weather.validation";

/**
 * One decimal place, about 10 km: enough for the weather, not enough to say
 * where someone lives.
 */
export function coarseLocation({
  latitude,
  longitude,
  label,
}: TodayWeatherLocation): TodayWeatherLocation {
  return {
    latitude: Math.round(latitude * 10) / 10,
    longitude: Math.round(longitude * 10) / 10,
    ...(label ? { label } : {}),
  };
}
