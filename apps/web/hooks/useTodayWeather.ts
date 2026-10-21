"use client";

import { useCallback } from "react";
import { useUser } from "@/hooks/useUser";
import { saveTodayWeatherAction } from "@/utils/actions/today-weather";
import type { TodayWeatherLocation } from "@/utils/actions/today-weather.validation";
import { coarseLocation } from "@/utils/weather/coarse-location";

/**
 * Today's weather setting, kept in the user's settings: where it's for, or
 * that they said "Not now". Today, Settings and the command palette all
 * change it here, so they show the same thing straight away.
 */
export function useTodayWeather() {
  const { data: user, mutate } = useUser();

  /**
   * A location turns it on; none turns it off, and `dismissed` stops the
   * offer. Resolves false, with the change undone, if it couldn't be saved.
   */
  const save = useCallback(
    async (next: TodayWeatherLocation | null, { dismissed = false } = {}) => {
      if (!user) return false;
      const stored = next ? coarseLocation(next) : null;
      mutate(
        { ...user, todayWeather: stored, todayWeatherDismissed: dismissed },
        { revalidate: false },
      );
      const result = await saveTodayWeatherAction({
        location: stored,
        dismissed,
      });
      if (result?.serverError || result?.validationErrors) {
        mutate();
        return false;
      }
      return true;
    },
    [user, mutate],
  );

  return {
    user,
    location: user?.todayWeather ?? null,
    dismissed: Boolean(user?.todayWeatherDismissed),
    save,
  };
}
