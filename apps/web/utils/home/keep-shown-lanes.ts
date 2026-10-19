import type { GetHomeResponse } from "@/app/api/user/home/route";
import type { HomeLane } from "@/utils/home/get-home";

/**
 * Today as the page holds it: `stale` lanes are rows an earlier answer showed,
 * kept on screen while Gmail is asked again for them. They aren't `pending`,
 * which shows placeholders, but are refreshed just the same.
 */
export type TodayHomeData = GetHomeResponse & { stale?: HomeLane[] };

/**
 * A fresh answer, with each lane Gmail couldn't serve in time kept as the
 * page last showed it rather than swapped for placeholders, so a refresh
 * never empties what is already on screen. A lane that failed or was still
 * loading before stays as the fresh answer has it.
 */
export function keepShownLanes(
  shown: TodayHomeData | undefined,
  fresh: TodayHomeData,
): TodayHomeData {
  if (!shown || !fresh.pending?.length) return fresh;
  const kept = fresh.pending.filter(
    (lane) =>
      !shown.failed?.includes(lane) &&
      (!shown.pending?.includes(lane) || shown.stale?.includes(lane)),
  );
  if (!kept.length) return fresh;

  const next: TodayHomeData = {
    ...fresh,
    pending: fresh.pending.filter((lane) => !kept.includes(lane)),
    stale: [...new Set([...(fresh.stale ?? []), ...kept])],
    stats: { ...fresh.stats },
  };
  for (const lane of kept) {
    next[lane] = shown[lane];
    if (lane === "needsYou") {
      next.stats.needsYou = shown.stats.needsYou;
      next.stats.estimatedMinutes = shown.stats.estimatedMinutes;
      next.stats.needsYouCapped = shown.stats.needsYouCapped;
    } else if (lane === "waiting") {
      next.stats.waiting = shown.stats.waiting;
      next.stats.waitingCapped = shown.stats.waitingCapped;
    }
  }
  return next;
}
