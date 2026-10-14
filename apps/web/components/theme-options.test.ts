import { describe, expect, it } from "vitest";
import { getForcedTheme } from "@/components/theme-options";

describe("getForcedTheme", () => {
  it("keeps the light-only marketing pages light", () => {
    expect(getForcedTheme("/pricing")).toBe("light");
    expect(getForcedTheme("/home")).toBe("light");
    expect(getForcedTheme("/welcome-upgrade/annual")).toBe("light");
  });

  it("lets the app, sign-in and onboarding follow the chosen theme", () => {
    expect(getForcedTheme("/login")).toBeUndefined();
    expect(getForcedTheme("/welcome")).toBeUndefined();
    expect(getForcedTheme("/settings")).toBeUndefined();
    expect(getForcedTheme("/mail/u/0/inbox")).toBeUndefined();
    // An account's Today page is not the marketing home page.
    expect(getForcedTheme("/cmv8659g20002hc7d2lx42vuk/home")).toBeUndefined();
    // Only whole path segments match.
    expect(getForcedTheme("/pricing-faq")).toBeUndefined();
    expect(getForcedTheme("/apps")).toBeUndefined();
  });

  it("does not force a theme before the path is known", () => {
    expect(getForcedTheme(null)).toBeUndefined();
  });
});
