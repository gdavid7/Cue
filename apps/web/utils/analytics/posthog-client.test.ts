/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_POSTHOG_KEY: undefined as string | undefined,
}));
const library = vi.hoisted(() => ({
  downloads: 0,
  flagsListener: undefined as ((flags: string[]) => void) | undefined,
  instance: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    register: vi.fn(),
    isFeatureEnabled: vi.fn(),
    onFeatureFlags: vi.fn(),
    featureFlags: { getFlags: vi.fn((): string[] => []) },
  },
}));

vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("posthog-js", () => {
  library.downloads++;
  return { default: library.instance };
});

describe("posthog client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    library.downloads = 0;
    library.flagsListener = undefined;
    library.instance.featureFlags.getFlags.mockReturnValue([]);
    library.instance.onFeatureFlags.mockImplementation((listener) => {
      library.flagsListener = listener;
    });
    mockEnv.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  });

  it("downloads nothing when PostHog is not configured", async () => {
    mockEnv.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    const { posthog, loadPostHog } = await importClient();
    const init = vi.fn();

    posthog.capture("$pageview");
    loadPostHog(init);
    await flushLoad();

    expect(library.downloads).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it("replays calls made before loading, after init and in order", async () => {
    const { posthog, loadPostHog } = await importClient();
    const init = vi.fn();

    posthog.identify("user@example.com", { email: "user@example.com" });
    posthog.capture("$pageview", { $current_url: "https://app/mail" });
    expect(library.instance.capture).not.toHaveBeenCalled();

    loadPostHog(init);
    await vi.waitFor(() => expect(library.instance.capture).toHaveBeenCalled());

    expect(library.downloads).toBe(1);
    expect(init).toHaveBeenCalledWith(library.instance, "phc_test");
    const [initOrder] = init.mock.invocationCallOrder;
    const [identifyOrder] = library.instance.identify.mock.invocationCallOrder;
    const [captureOrder] = library.instance.capture.mock.invocationCallOrder;
    expect(initOrder).toBeLessThan(identifyOrder);
    expect(identifyOrder).toBeLessThan(captureOrder);
    expect(library.instance.identify).toHaveBeenCalledWith("user@example.com", {
      email: "user@example.com",
    });
    // Queued events keep the time they happened.
    expect(library.instance.capture).toHaveBeenCalledWith(
      "$pageview",
      { $current_url: "https://app/mail" },
      { timestamp: expect.any(Date) },
    );

    posthog.capture("later", undefined, { transport: "sendBeacon" });
    expect(library.instance.capture).toHaveBeenLastCalledWith(
      "later",
      undefined,
      { transport: "sendBeacon" },
    );
  });

  it("updates feature flag hooks once flags arrive", async () => {
    const { loadPostHog, useFeatureFlagEnabled } = await importClient();
    library.instance.isFeatureEnabled.mockReturnValue(undefined);
    const { result } = renderHook(() => useFeatureFlagEnabled("booking-links"));
    expect(result.current).toBeUndefined();

    loadPostHog(vi.fn());
    await vi.waitFor(() => expect(library.flagsListener).toBeDefined());
    library.instance.isFeatureEnabled.mockReturnValue(true);
    act(() => library.flagsListener?.(["booking-links"]));

    expect(result.current).toBe(true);
  });

  it("shows flags saved from an earlier visit as soon as PostHog loads", async () => {
    const { loadPostHog, useActiveFeatureFlags, useFeatureFlagEnabled } =
      await importClient();
    const { result } = renderHook(() => ({
      enabled: useFeatureFlagEnabled("booking-links"),
      active: useActiveFeatureFlags(),
    }));
    library.instance.isFeatureEnabled.mockReturnValue(true);
    library.instance.featureFlags.getFlags.mockReturnValue(["booking-links"]);

    loadPostHog(vi.fn());

    // No /flags response has arrived; the listener is never called.
    await vi.waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.active).toEqual(["booking-links"]);
    expect(library.flagsListener).toBeDefined();
  });

  it("lets a sign-in redirect wait briefly for PostHog, never for long", async () => {
    const { posthog, loadPostHog, whenReady } = await importClient();
    const startedAt = Date.now();

    // Still loading: gives up after the timeout.
    await whenReady(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);

    posthog.capture("Authentication Started");
    loadPostHog(vi.fn());
    await whenReady(5000);

    expect(library.instance.capture).toHaveBeenCalledWith(
      "Authentication Started",
      undefined,
      { timestamp: expect.any(Date) },
    );
  });

  it("stops queueing once PostHog has failed to load", async () => {
    const { posthog, loadPostHog, whenReady } = await importClient();
    const init = vi.fn(() => {
      throw new Error("PostHog failed to start");
    });
    posthog.capture("before failure");

    loadPostHog(init);
    await whenReady(5000);
    posthog.capture("after failure");

    // Settles at once now, rather than waiting out the timeout.
    const startedAt = Date.now();
    await whenReady(1000);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(init).toHaveBeenCalledTimes(1);
    expect(library.instance.capture).not.toHaveBeenCalled();
  });
});

async function importClient() {
  const [client, flags] = await Promise.all([
    import("@/utils/analytics/posthog-client"),
    import("@/utils/analytics/posthog-flags"),
  ]);
  return { ...client, ...flags };
}

async function flushLoad() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
