/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { guardRestoredPage } from "./restored-page";
import { resetSigningOut, startSigningOut } from "./signing-out";
import { armSessionExpiredRedirect } from "./session-expired";

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("@/utils/redirect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/redirect")>()),
  redirectToSafeUrl: mocks.redirect,
}));

afterEach(() => {
  resetSigningOut();
  mocks.redirect.mockReset();
  vi.unstubAllGlobals();
});

describe("guardRestoredPage", () => {
  it("sends a page restored mid sign-out to log in", () => {
    const stop = guardRestoredPage();
    startSigningOut();

    restore();

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
    stop();
  });

  it("sends a restored page whose session is gone to log in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    const disarm = armSessionExpiredRedirect();
    const stop = guardRestoredPage();

    restore();

    await vi.waitFor(() => expect(mocks.redirect).toHaveBeenCalledTimes(1));
    stop();
    disarm();
  });

  it("leaves a restored page with a live session alone, and ignores ordinary loads", async () => {
    const fetchMock = vi.fn(async () => Response.json({ session: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const disarm = armSessionExpiredRedirect();
    const stop = guardRestoredPage();

    restore(false);
    restore();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(mocks.redirect).not.toHaveBeenCalled();
    stop();
    disarm();
  });
});

function restore(persisted = true) {
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}
