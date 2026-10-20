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
});
