"use client";

import { type FormEvent, useState } from "react";
import useSWR from "swr";
import {
  CloudFogIcon,
  CloudIcon,
  CloudLightningIcon,
  CloudRainIcon,
  CloudSnowIcon,
  CloudSunIcon,
  LocateFixedIcon,
  type LucideIcon,
  SunIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { saveTodayWeatherAction } from "@/utils/actions/today-weather";
import type { TodayWeatherLocation } from "@/utils/actions/today-weather.validation";
import { createBrowserCache } from "@/utils/browser-cache";
import { coarseLocation } from "@/utils/weather/coarse-location";
import {
  describeWeather,
  fetchWeather,
  findCity,
  temperatureUnitFor,
  type Weather,
  type WeatherKind,
} from "@/utils/weather/open-meteo";

const GEOLOCATION_TIMEOUT_MS = 10_000;
// Weather moves slowly; asking more often than this only costs the service.
const weatherCache = createBrowserCache<Weather>({
  name: "today-weather",
  ttlMs: 30 * 60_000,
  maxEntries: 4,
  maxBytes: 4 * 1024,
});

const ICONS: Record<WeatherKind, LucideIcon> = {
  clear: SunIcon,
  partly: CloudSunIcon,
  cloudy: CloudIcon,
  fog: CloudFogIcon,
  rain: CloudRainIcon,
  snow: CloudSnowIcon,
  storm: CloudLightningIcon,
};

/**
 * A glanceable weather line for Today, off until the user turns it on. Where
 * it's for comes only from the browser's location when they ask for it, or a
 * city they type; it's kept coarse, and the forecast is asked for from this
 * browser, so no location passes through Cue's servers. It fails quietly.
 */
export function TodayWeather() {
  const { emailAccountId } = useAccount();
  const { data: user, mutate } = useUser();
  const [open, setOpen] = useState(false);
  const location = user?.todayWeather ?? null;
  const unit =
    typeof navigator === "undefined"
      ? "celsius"
      : temperatureUnitFor(navigator.language);
  const cacheKey = location
    ? `${location.latitude},${location.longitude},${unit}`
    : null;
  const { data: weather, error } = useSWR(
    cacheKey ? ["today-weather", cacheKey] : null,
    async () => {
      if (!location || !cacheKey) throw new Error("No location");
      const cached = weatherCache.get(emailAccountId, cacheKey);
      if (cached) return cached;
      const fresh = await fetchWeather(location, unit);
      weatherCache.set(emailAccountId, cacheKey, fresh);
      return fresh;
    },
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: 30 * 60_000,
    },
  );

  if (!user) return null;

  const save = async (next: TodayWeatherLocation | null) => {
    const stored = next ? coarseLocation(next) : null;
    mutate({ ...user, todayWeather: stored }, { revalidate: false });
    setOpen(false);
    const result = await saveTodayWeatherAction({ location: stored });
    if (result?.serverError || result?.validationErrors) mutate();
  };

  const trigger = location ? (
    <WeatherLine
      error={Boolean(error)}
      label={location.label}
      unit={unit}
      weather={weather}
    />
  ) : (
    <>
      <CloudSunIcon aria-hidden className="size-4" />
      Show weather
    </>
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="-mx-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-sm hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted max-sm:min-h-11"
          type="button"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        <WeatherSettings
          location={location}
          onSave={save}
          onTurnOff={() => save(null)}
        />
      </PopoverContent>
    </Popover>
  );
}

function WeatherLine({
  weather,
  error,
  label,
  unit,
}: {
  weather?: Weather;
  error: boolean;
  label?: string;
  unit: "celsius" | "fahrenheit";
}) {
  // Until it loads, or if the service is down, the line stays as quiet as it
  // can while still opening the settings.
  if (!weather) {
    return (
      <>
        <CloudSunIcon aria-hidden className="size-4" />
        <span className={error ? undefined : "invisible"}>
          {label ?? "Weather"}
        </span>
      </>
    );
  }
  const { label: sky, kind } = describeWeather(weather.code);
  const Icon = ICONS[kind];
  const degrees = unit === "fahrenheit" ? "°F" : "°C";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="text-foreground tabular-nums">
        {weather.temperature}°<span className="sr-only">{degrees}</span>
      </span>
      <span>{sky}</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">
        H {weather.high}° L {weather.low}°
      </span>
      {label ? (
        <>
          <span aria-hidden>·</span>
          <span className="max-w-32 truncate">{label}</span>
        </>
      ) : null}
    </span>
  );
}

/** Where the weather is for: this browser's location on request, or a city. */
function WeatherSettings({
  location,
  onSave,
  onTurnOff,
}: {
  location: TodayWeatherLocation | null;
  onSave: (location: TodayWeatherLocation) => void;
  onTurnOff: () => void;
}) {
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState<"locating" | "searching" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) {
      setProblem("This browser can't share its location. Type a city instead.");
      return;
    }
    setBusy("locating");
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setBusy(null);
        onSave({ latitude: coords.latitude, longitude: coords.longitude });
      },
      () => {
        setBusy(null);
        setProblem("Couldn't get your location. Type a city instead.");
      },
      {
        // A city-level fix is all the weather needs, and comes faster.
        enableHighAccuracy: false,
        maximumAge: 60 * 60_000,
        timeout: GEOLOCATION_TIMEOUT_MS,
      },
    );
  };

  const searchCity = async (event: FormEvent) => {
    event.preventDefault();
    if (!city.trim()) return;
    setBusy("searching");
    setProblem(null);
    try {
      const found = await findCity(city);
      if (found) onSave(found);
      else setProblem("Couldn't find that city.");
    } catch {
      setProblem("Couldn't look that up right now. Try again later.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="space-y-1">
        <p className="font-medium text-foreground">Weather on Today</p>
        <p className="text-muted-foreground text-xs">
          Cue keeps only your approximate area, and asks Open-Meteo for the
          forecast from this browser.
        </p>
      </div>
      <Button
        className="w-full"
        disabled={busy !== null}
        loading={busy === "locating"}
        onClick={useMyLocation}
        size="sm"
        variant="outline"
      >
        <LocateFixedIcon aria-hidden className="mr-2 size-4" />
        Use my location
      </Button>
      <form className="flex gap-2" onSubmit={searchCity}>
        <Input
          aria-label="City"
          autoComplete="address-level2"
          className="h-9"
          maxLength={100}
          name="city"
          onChange={(event) => setCity(event.target.value)}
          placeholder="Or type a city"
          value={city}
        />
        <Button
          disabled={busy !== null || !city.trim()}
          loading={busy === "searching"}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Show
        </Button>
      </form>
      {problem ? (
        <p className="text-muted-foreground text-xs" role="alert">
          {problem}
        </p>
      ) : null}
      {location ? (
        <Button
          className="w-full"
          onClick={onTurnOff}
          size="sm"
          variant="ghostMuted"
        >
          Turn off weather
        </Button>
      ) : null}
    </>
  );
}
