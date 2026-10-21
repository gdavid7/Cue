"use client";

import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";
import {
  getReleaseVelocity,
  getSwipeAction,
  getSwipeOffset,
  getSwipeTravel,
  isArmed,
  isEdgeGesture,
  type RowSwipeAction,
  type RowSwipeAxis,
  resolveAxis,
  resolveRelease,
  springAt,
  type VelocitySample,
} from "@/app/(app)/[emailAccountId]/mail/row-swipe";

/** Apple's reposition spring: critically damped, settles in about this long. */
const SETTLE_RESPONSE_S = 0.35;
/** Leaving is quicker than settling back, so the list moves on promptly. */
const DISMISS_RESPONSE_S = 0.25;
/** The list hides an archived row; if it doesn't, the row returns. */
const DISMISSED_RESET_MS = 800;

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startTravel: number;
  axis: RowSwipeAxis;
  samples: VelocitySample[];
  armed: boolean;
  interrupted: boolean;
};

/**
 * Swipes a mail row with a finger: it follows 1:1, resists past the commit
 * point, and springs back or away from wherever it is on release. Writes to
 * the DOM directly so tracking never waits on React. Mouse and pen input,
 * and so the desktop list, never move the row.
 *
 * `track` clips the row and carries `data-swiping` (the action whose side is
 * showing) and `data-armed` for the reveal behind it; `layer` is what moves.
 */
export function useRowSwipe({
  enabled,
  onCommit,
}: {
  enabled: Record<RowSwipeAction, boolean> | null;
  onCommit: (action: RowSwipeAction) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const offset = useRef(0);
  const frame = useRef<number | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swallowClick = useRef(false);
  // From an archive's commit until its row is gone, the row is no longer
  // the user's to move: a second grab would archive again.
  const dismissing = useRef(false);
  const latest = useRef({ enabled, onCommit });
  latest.current = { enabled, onCommit };

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const width = () => trackRef.current?.offsetWidth ?? 0;

  const paint = (value: number) => {
    offset.current = value;
    const track = trackRef.current;
    const layer = layerRef.current;
    if (!track || !layer) return;
    const action = getSwipeAction(value);
    if (!action) {
      layer.style.transform = "";
      layer.style.willChange = "";
      delete track.dataset.swiping;
      delete track.dataset.armed;
      return;
    }
    layer.style.transform = `translate3d(${value}px, 0, 0)`;
    layer.style.willChange = "transform";
    track.dataset.swiping = action;
  };

  const stopAnimation = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = null;
  };

  const animateTo = ({
    to,
    velocity,
    response,
    onDone,
  }: {
    to: number;
    velocity: number;
    response: number;
    onDone?: () => void;
  }) => {
    stopAnimation();
    const from = offset.current;
    if (prefersReducedMotion()) {
      // No slide: the row is simply where it ends up.
      paint(to === 0 ? 0 : from);
      onDone?.();
      return;
    }
    const start = performance.now();
    const step = () => {
      const spring = springAt({
        from,
        to,
        velocity,
        response,
        // performance.now(), not the frame's timestamp, which can predate
        // `start` and would run the spring backwards.
        elapsed: Math.max(0, (performance.now() - start) / 1000),
      });
      const settled =
        Math.abs(spring.value - to) < 0.5 && Math.abs(spring.velocity) < 20;
      // A row leaving is done once it's out of sight.
      const gone = to !== 0 && Math.abs(spring.value) >= width();
      if (settled || gone) {
        frame.current = null;
        paint(settled ? to : spring.value);
        onDone?.();
        return;
      }
      paint(spring.value);
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  const release = (velocity: number) => {
    const current = latest.current.enabled;
    const action = current
      ? resolveRelease({
          offset: offset.current,
          velocity,
          width: width(),
          enabled: current,
        })
      : null;
    if (action === "archive") {
      dismissing.current = true;
      const exit = -(width() + 24);
      animateTo({
        to: exit,
        velocity: Math.min(velocity, 0),
        response: DISMISS_RESPONSE_S,
        onDone: () => {
          latest.current.onCommit("archive");
          resetTimer.current = setTimeout(() => {
            resetTimer.current = null;
            dismissing.current = false;
            paint(0);
          }, DISMISSED_RESET_MS);
        },
      });
      return;
    }
    // Read state flips in place, so the row comes home either way.
    if (action === "toggleRead") latest.current.onCommit("toggleRead");
    animateTo({ to: 0, velocity, response: SETTLE_RESPONSE_S });
  };

  const end = (event: PointerEvent, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.axis === "horizontal" || current.interrupted)
      swallowClick.current = true;
    if (current.axis !== "horizontal") {
      if (offset.current !== 0)
        animateTo({ to: 0, velocity: 0, response: SETTLE_RESPONSE_S });
      return;
    }
    if (cancelled) {
      animateTo({ to: 0, velocity: 0, response: SETTLE_RESPONSE_S });
      return;
    }
    release(getReleaseVelocity(current.samples));
  };

  return {
    trackRef,
    layerRef,
    handlers: {
      onPointerDown: (event: PointerEvent) => {
        // A tap on a row on its way out shouldn't open it either.
        swallowClick.current = dismissing.current;
        const current = latest.current.enabled;
        if (
          event.pointerType !== "touch" ||
          !current ||
          !event.isPrimary ||
          dismissing.current
        )
          return;
        if (
          offset.current === 0 &&
          isEdgeGesture(event.clientX, window.innerWidth)
        )
          return;
        const interrupted = frame.current !== null || offset.current !== 0;
        stopAnimation();
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startTravel: getSwipeTravel({
            offset: offset.current,
            width: width(),
            enabled: current,
          }),
          // A row grabbed mid-flight is already a horizontal drag.
          axis: interrupted ? "horizontal" : "pending",
          samples: [{ x: offset.current, t: event.timeStamp }],
          armed: false,
          interrupted,
        };
      },
      onPointerMove: (event: PointerEvent) => {
        const current = gesture.current;
        const enabledActions = latest.current.enabled;
        if (
          !current ||
          current.pointerId !== event.pointerId ||
          !enabledActions
        )
          return;
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        if (current.axis === "pending") {
          current.axis = resolveAxis(dx, dy);
          if (current.axis === "horizontal") {
            try {
              trackRef.current?.setPointerCapture(event.pointerId);
            } catch {}
          }
        }
        if (current.axis !== "horizontal") return;
        const rowWidth = width();
        const value = getSwipeOffset({
          travel: current.startTravel + dx,
          width: rowWidth,
          enabled: enabledActions,
        });
        paint(value);
        current.samples.push({ x: value, t: event.timeStamp });
        if (current.samples.length > 8) current.samples.shift();
        const armed = isArmed({
          offset: value,
          width: rowWidth,
          enabled: enabledActions,
        });
        if (armed !== current.armed) {
          current.armed = armed;
          if (armed) {
            if (trackRef.current) trackRef.current.dataset.armed = "";
            // The commit point is a detent, felt where the hardware allows.
            navigator.vibrate?.(8);
          } else if (trackRef.current) {
            delete trackRef.current.dataset.armed;
          }
        }
      },
      onPointerUp: (event: PointerEvent) => end(event, false),
      // The browser took the touch for a scroll or system gesture.
      onPointerCancel: (event: PointerEvent) => end(event, true),
      onClickCapture: (event: MouseEvent) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
