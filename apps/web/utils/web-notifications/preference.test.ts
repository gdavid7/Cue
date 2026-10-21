// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_QUIET_MS,
  pauseNotificationsUntil,
  readEffectiveMode,
  readQuietUntilMs,
  resumeNotifications,
  subscribeToPreference,
} from "@/utils/web-notifications/preference";

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pausing notifications", () => {
  it("keeps the chosen mode, so a pause never reads as notifications off", () => {
    pauseNotificationsUntil(Date.now() + HOUR_MS);

    expect(readQuietUntilMs()).toBe(Date.now() + HOUR_MS);
    expect(readEffectiveMode()).toBe("important");
  });

  it("resumes on its own at the chosen time, telling subscribers without a reload", async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToPreference(onChange);
    pauseNotificationsUntil(Date.now() + HOUR_MS);
    onChange.mockClear();

    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(readQuietUntilMs()).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(readQuietUntilMs()).toBeNull();
    expect(onChange).toHaveBeenCalled();
    unsubscribe();
  });

  it("follows a pause chosen in another tab, and its end", async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToPreference(onChange);

    // Another tab writes storage directly; this one only gets the event.
    window.localStorage.setItem(
      "cue:web-notifications:quiet-until",
      String(Date.now() + HOUR_MS),
    );
    window.dispatchEvent(new StorageEvent("storage"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(readQuietUntilMs()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(readQuietUntilMs()).toBeNull();
    unsubscribe();
  });

  it("stops the resume timer once nobody is listening", async () => {
    const onChange = vi.fn();
    pauseNotificationsUntil(Date.now() + HOUR_MS);
    subscribeToPreference(onChange)();

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a time already past, without telling anyone", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToPreference(onChange);

    pauseNotificationsUntil(Date.now() - 1);

    expect(readQuietUntilMs()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("cuts a pause beyond 30 days to 30 days", () => {
    pauseNotificationsUntil(Date.now() + 90 * 24 * HOUR_MS);

    expect(readQuietUntilMs()).toBe(Date.now() + MAX_QUIET_MS);
    expect(MAX_QUIET_MS).toBe(30 * 24 * HOUR_MS);
  });

  it("resumes early when asked", () => {
    pauseNotificationsUntil(Date.now() + HOUR_MS);
    resumeNotifications();

    expect(readQuietUntilMs()).toBeNull();
  });

  it("reads as not paused when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => pauseNotificationsUntil(Date.now() + HOUR_MS)).not.toThrow();
    expect(readQuietUntilMs()).toBeNull();
  });
});
