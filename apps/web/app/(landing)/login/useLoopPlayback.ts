"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Whether a landing-page demo loop should play: only while it's well on
 * screen and the tab is visible, never while the pointer rests on it or after
 * the viewer paused it, and never for people who asked for reduced motion.
 */
export function useLoopPlayback(ref: RefObject<HTMLElement | null>) {
  const [onScreen, setOnScreen] = useState(false);
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  // Assume reduced motion until the browser says otherwise, so nothing moves
  // before we know.
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { threshold: 0.35 },
    );
    observer.observe(element);

    const hold = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setHeld(true);
    };
    const release = () => setHeld(false);
    element.addEventListener("pointerenter", hold);
    element.addEventListener("pointerleave", release);

    return () => {
      observer.disconnect();
      element.removeEventListener("pointerenter", hold);
      element.removeEventListener("pointerleave", release);
    };
  }, [ref]);

  return {
    playing: onScreen && pageVisible && !held && !paused && !reducedMotion,
    reducedMotion,
    paused,
    togglePaused: () => setPaused((current) => !current),
  };
}

/**
 * Steps through a loop whose step `i` lasts `durations[i]` ms. Pausing keeps
 * the time left in the current step, so a paused loop resumes where it was.
 * `durations` must be a stable array.
 */
export function useLoopSteps(
  durations: readonly number[],
  playing: boolean,
  initialStep: number,
) {
  const [step, setStep] = useState(initialStep);
  const lastStep = useRef(step);
  const remaining = useRef(durations[initialStep]);

  useEffect(() => {
    if (lastStep.current !== step) {
      lastStep.current = step;
      remaining.current = durations[step];
    }
    if (!playing) return;

    const startedAt = performance.now();
    const timer = window.setTimeout(
      () => setStep((current) => (current + 1) % durations.length),
      remaining.current,
    );
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - startedAt),
      );
    };
  }, [durations, playing, step]);

  return step;
}
