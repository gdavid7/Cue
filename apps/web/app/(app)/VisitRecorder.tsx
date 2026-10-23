"use client";

import { useEffect } from "react";
import { recordVisit } from "@/utils/user/record-visit";

/**
 * Records that the user is using the app: on load, on input, and when the
 * tab comes back into view. The app layout renders once per hard load, not
 * on client navigation, so it can't tell an hour in Mail from a day away.
 */
export function VisitRecorder() {
  useEffect(() => {
    const record = () => {
      if (document.visibilityState === "visible") recordVisit();
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
  }, []);
  return null;
}
