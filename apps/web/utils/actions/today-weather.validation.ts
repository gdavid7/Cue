import { z } from "zod";

/** Where Today's weather is for: coarse, and only what the user chose. */
export const todayWeatherLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** The city the user typed, as the weather service named it. */
  label: z.string().trim().min(1).max(100).optional(),
});
export type TodayWeatherLocation = z.infer<typeof todayWeatherLocationSchema>;

export const saveTodayWeatherBody = z.object({
  /** Null turns the weather off. */
  location: todayWeatherLocationSchema.nullable(),
  /** With no location: the user said "Not now", so Today stops offering it. */
  dismissed: z.boolean().optional(),
});

/** What User.todayWeather holds: a location, or that the offer was dismissed. */
export const todayWeatherSettingSchema = z.union([
  todayWeatherLocationSchema,
  z.object({ dismissed: z.literal(true) }),
]);
