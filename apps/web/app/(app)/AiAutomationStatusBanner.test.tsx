/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiAutomationStatusBanner } from "./AiAutomationStatusBanner";

const premium = vi.hoisted(() => ({
  current: {
    isLoading: true,
    hasAiAccess: false,
    isProPlanWithoutApiKey: false,
  },
}));

vi.mock("@/hooks/usePremium", () => ({ usePremium: () => premium.current }));
vi.mock("@/hooks/useAiAutomationStatus", () => ({
  useAiAutomationStatus: () => ({ data: undefined }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/mail/u/0/inbox" }));
vi.mock("@/components/EndTrialButton", () => ({ EndTrialButton: () => null }));

const NOTICE = /The AI assistant is off/;
const NO_AI = { hasAiAccess: false, isProPlanWithoutApiKey: false };

beforeEach(() => {
  premium.current = {
    isLoading: true,
    hasAiAccess: false,
    isProPlanWithoutApiKey: false,
  };
  document.cookie = "cue-no-ai-banner-dismissed=; max-age=0; path=/";
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("AiAutomationStatusBanner", () => {
  it("is in the server's HTML, so it never pushes the page down later", () => {
    const html = renderToString(
      <AiAutomationStatusBanner aiAccess={NO_AI} dismissed={false} />,
    );

    expect(html).toMatch(NOTICE);
  });

  it("stays out of the server's HTML once dismissed", () => {
    const html = renderToString(
      <AiAutomationStatusBanner aiAccess={NO_AI} dismissed />,
    );

    expect(html).not.toMatch(NOTICE);
  });

  it("hydrates the server's banner without a mismatch", async () => {
    const banner = (
      <AiAutomationStatusBanner aiAccess={NO_AI} dismissed={false} />
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(banner);
    document.body.append(container);
    const recoverable = vi.fn();

    await act(async () => {
      hydrateRoot(container, banner, { onRecoverableError: recoverable });
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it("follows the loaded account once it arrives", () => {
    premium.current = {
      isLoading: false,
      hasAiAccess: true,
      isProPlanWithoutApiKey: false,
    };

    render(<AiAutomationStatusBanner aiAccess={NO_AI} dismissed={false} />);

    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("remembers a dismissal where the server can read it", async () => {
    render(<AiAutomationStatusBanner aiAccess={NO_AI} dismissed={false} />);

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(document.cookie).toContain("cue-no-ai-banner-dismissed=1");
  });
});
