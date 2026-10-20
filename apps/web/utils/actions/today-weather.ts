"use server";

import { Prisma } from "@/generated/prisma/client";
import { saveTodayWeatherBody } from "@/utils/actions/today-weather.validation";
import { actionClientUser } from "@/utils/actions/safe-action";
import prisma from "@/utils/prisma";
import { coarseLocation } from "@/utils/weather/coarse-location";

export const saveTodayWeatherAction = actionClientUser
  .metadata({ name: "saveTodayWeather" })
  .schema(saveTodayWeatherBody)
  .action(async ({ ctx: { userId }, parsedInput: { location } }) => {
    // Rounded here too, so a precise position is never stored whatever sent it.
    const todayWeather = location ? coarseLocation(location) : Prisma.DbNull;
    await prisma.user.update({
      where: { id: userId },
      data: { todayWeather },
    });
    return { success: true };
  });
