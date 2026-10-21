"use client";

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastError } from "@/components/Toast";
import { useTodayWeather } from "@/hooks/useTodayWeather";

/**
 * Where "Not now" on Today's weather can be undone. On means Today shows the
 * weather, or offers it; off removes the location and stops the offer.
 */
export function TodayWeatherSetting() {
  const { user, dismissed, save } = useTodayWeather();

  const toggle = async (on: boolean) => {
    const saved = await save(null, { dismissed: !on });
    if (!saved) toastError({ description: "Couldn't save. Try again." });
  };

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Weather on Today</ItemTitle>
          <ItemDescription>
            A forecast line on Today, for a place you choose there.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {user ? (
            <Switch
              aria-label="Weather on Today"
              checked={!dismissed}
              onCheckedChange={toggle}
            />
          ) : (
            <Skeleton className="h-5 w-9 rounded-full" />
          )}
        </ItemActions>
      </Item>
    </>
  );
}
