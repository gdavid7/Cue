import { useLayoutEffect, useRef } from "react";
import {
  isMailPerformanceSampled,
  recordThreadSwitchLatency,
} from "@/utils/analytics/mail-performance";
import {
  beginRumAction,
  cancelRumAction,
  completeRumAction,
} from "@/utils/analytics/rum-actions";

/**
 * Measures how long the reader takes to show a thread after it is opened (J/K,
 * arrows, Enter or a click all change the open key): every open as a real-user
 * timing event, and in sampled sessions also in the performance summary.
 */
export function useMailPerformanceTelemetry({
  openThreadKey,
  visibleThreadKey,
}: {
  openThreadKey: string | null;
  visibleThreadKey: string | undefined;
}) {
  const pendingSwitch = useRef<{ key: string; startedAt: number } | null>(null);
  const visibleKey = useRef(visibleThreadKey);
  visibleKey.current = visibleThreadKey;

  useLayoutEffect(() => {
    // A thread the reader already shows never reports ready again.
    if (openThreadKey && openThreadKey !== visibleKey.current) {
      beginRumAction("thread_open", { key: openThreadKey });
    } else {
      cancelRumAction("thread_open");
    }
    pendingSwitch.current =
      isMailPerformanceSampled() && openThreadKey
        ? { key: openThreadKey, startedAt: performance.now() }
        : null;
  }, [openThreadKey]);

  useLayoutEffect(() => {
    if (visibleThreadKey) {
      completeRumAction("thread_open", { key: visibleThreadKey });
    }
    const pending = pendingSwitch.current;
    if (!pending || pending.key !== visibleThreadKey) return;
    pendingSwitch.current = null;
    recordThreadSwitchLatency(performance.now() - pending.startedAt);
  }, [visibleThreadKey]);
}
