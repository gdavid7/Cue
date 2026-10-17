/** @vitest-environment jsdom */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogProvider } from "@/providers/PostHogProvider";

const mockLoadPostHog = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ current: "/mail" }));

vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_POSTHOG_KEY: "phc_test" } }));
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.current,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/utils/analytics/posthog-client", () => ({
  loadPostHog: mockLoadPostHog,
  posthog: { capture: vi.fn() },
}));
// Holds the after-load path back, so each test sees only the early triggers.
vi.mock("@/utils/schedule-after-page-load", () => ({
  scheduleAfterPageLoad: () => () => {},
}));
vi.mock("@/utils/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccount: null }),
}));

describe("PostHogProvider", () => {
  afterEach(() => {
    cleanup();
    mockLoadPostHog.mockClear();
    mockPathname.current = "/mail";
  });

  it("starts loading PostHog on the first click, before the page settles", () => {
    render(<PostHogProvider>content</PostHogProvider>);
    expect(mockLoadPostHog).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);

    expect(mockLoadPostHog).toHaveBeenCalledTimes(1);
  });

  it("starts loading PostHog at once on the login page", () => {
    mockPathname.current = "/login";

    render(<PostHogProvider>content</PostHogProvider>);

    expect(mockLoadPostHog).toHaveBeenCalledTimes(1);
  });
});
