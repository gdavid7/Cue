"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { useUser } from "@/hooks/useUser";
import { onVisitReturn, recordVisit } from "@/utils/user/record-visit";

const AWAY_SUMMARY_KEY = "/api/user/home/away";

/**
 * Records that the user is using the app: on load, on input, and when the
 * tab comes back into view. The app layout renders once per hard load, not
 * on client navigation, so it can't tell an hour in Mail from a day away.
 * A return after a break reloads "While you were away", so a Today left
 * open overnight shows the morning's card on the first click.
 */
export function VisitRecorder() {
  const { data: user } = useUser();
  const userId = user?.id;
  const { mutate } = useSWRConfig();

  useEffect(
    () =>
      onVisitReturn(() => {
        mutate(
          (key) => typeof key === "string" && key.startsWith(AWAY_SUMMARY_KEY),
        );
      }),
    [mutate],
  );

  useEffect(() => {
    const record = () => {
      if (document.visibilityState === "visible") recordVisit({ userId });
    };
    record();
    document.addEventListener("visibilitychange", record);
    window.addEventListener("pointerdown", record, { passive: true });
    window.addEventListener("keydown", record);
    return () => {
      document.removeEventListener("visibilitychange", record);
      window.removeEventListener("pointerdown", record);
      window.removeEventListener("keydown", record);
    };
  }, [userId]);
  return null;
}
