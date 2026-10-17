"use client";

import { useSyncExternalStore } from "react";
import {
  getActiveFeatureFlags,
  isFeatureFlagEnabled,
  subscribeToFlags,
} from "@/utils/analytics/posthog-client";

export function useFeatureFlagEnabled(flag: string) {
  return useSyncExternalStore(
    subscribeToFlags,
    () => isFeatureFlagEnabled(flag),
    () => undefined,
  );
}

export function useActiveFeatureFlags() {
  return useSyncExternalStore(
    subscribeToFlags,
    getActiveFeatureFlags,
    getActiveFeatureFlags,
  );
}
