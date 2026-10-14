/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelWebAnalytics } from "@/components/VercelWebAnalytics";

(globalThis as { React?: typeof React }).React = React;

const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_VERCEL_WEB_ANALYTICS_ENABLED: false,
}));

vi.mock("@/env", () => ({ env: mockEnv }));

describe("VercelWebAnalytics", () => {
  afterEach(() => {
    cleanup();
    for (const script of analyticsScripts()) script.remove();
  });

  it("does not request the Web Analytics script when it is not enabled", () => {
    mockEnv.NEXT_PUBLIC_VERCEL_WEB_ANALYTICS_ENABLED = false;

    render(<VercelWebAnalytics />);

    expect(analyticsScripts()).toHaveLength(0);
  });

  it("loads the Web Analytics script once it is enabled", () => {
    mockEnv.NEXT_PUBLIC_VERCEL_WEB_ANALYTICS_ENABLED = true;

    render(<VercelWebAnalytics />);

    expect(analyticsScripts()).toHaveLength(1);
  });
});

function analyticsScripts() {
  return [...document.querySelectorAll("script")].filter((script) =>
    /\/_vercel\/insights\/script|va\.vercel-scripts\.com/.test(script.src),
  );
}
