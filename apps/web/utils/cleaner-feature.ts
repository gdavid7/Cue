import { env } from "@/env";
import { SafeError } from "@/utils/error";

export function isCleanerApiEnabled() {
  return process.env.VERCEL === "1" || !!env.NEXT_PUBLIC_CLEANER_ENABLED;
}

export function assertCleanerApiEnabled() {
  if (isCleanerApiEnabled()) return;

  throw new SafeError("Cleaner is not enabled", 404);
}
