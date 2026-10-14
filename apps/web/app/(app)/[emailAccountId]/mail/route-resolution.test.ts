import { describe, expect, it } from "vitest";
import { getRouteResolution } from "@/app/(app)/[emailAccountId]/mail/route-resolution";

describe("getRouteResolution", () => {
  it("waits while the names a slug needs are loading", () => {
    expect(
      getRouteResolution({ resolved: false, loading: true, failed: false }),
    ).toBe("resolving");
  });

  it("is ready once the slug resolves, even if a later refresh fails", () => {
    expect(
      getRouteResolution({ resolved: true, loading: false, failed: true }),
    ).toBe("ready");
  });

  // A failed settings or labels request would otherwise hold the list on its
  // placeholder forever (/mail/u/0/needs-reply with no settings).
  it("gives up when the names failed to load", () => {
    expect(
      getRouteResolution({ resolved: false, loading: false, failed: true }),
    ).toBe("failed");
  });

  it("takes an unknown slug as a provider id once names have loaded", () => {
    expect(
      getRouteResolution({ resolved: false, loading: false, failed: false }),
    ).toBe("ready");
  });
});
