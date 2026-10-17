// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingContent } from "@/components/LoadingContent";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.com" },
}));

describe("LoadingContent in development", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it("keeps loading through a transient 404 from a reloading dev server", () => {
    vi.stubEnv("NODE_ENV", "development");

    render(
      <LoadingContent
        error={{ status: 404 }}
        errorComponent={<div>Could not load</div>}
        loading={false}
        loadingComponent={<div>Loading</div>}
      >
        <div>Content</div>
      </LoadingContent>,
    );

    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("shows a 404 the server sent on purpose", () => {
    vi.stubEnv("NODE_ENV", "development");

    render(
      <LoadingContent
        error={{ info: { error: "Gone", isKnownError: true }, status: 404 }}
        errorComponent={<div>Could not load</div>}
        loading={false}
        loadingComponent={<div>Loading</div>}
      >
        <div>Content</div>
      </LoadingContent>,
    );

    expect(screen.getByText("Could not load")).toBeTruthy();
  });
});

describe("LoadingContent with data on screen", () => {
  afterEach(cleanup);

  it("keeps showing the data when a refresh fails", () => {
    render(
      <LoadingContent
        error={{ error: "Gmail is busy", status: 503 }}
        hasData
        loading={false}
      >
        <div>Content</div>
      </LoadingContent>,
    );

    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error when there is nothing to keep", () => {
    render(
      <LoadingContent
        error={{ error: "Gmail is busy", status: 503 }}
        hasData={false}
        loading={false}
      >
        <div>Content</div>
      </LoadingContent>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Content")).toBeNull();
  });
});
