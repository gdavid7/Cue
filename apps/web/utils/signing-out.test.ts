import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSigningOut,
  onSigningOut,
  resetSigningOut,
  signingOutSignal,
  startSigningOut,
  withSigningOutSignal,
} from "./signing-out";

afterEach(resetSigningOut);

describe("signing out", () => {
  it("aborts in-flight requests and tells listeners once", () => {
    const listener = vi.fn();
    onSigningOut(listener);
    const signal = withSigningOutSignal(undefined);

    startSigningOut();
    startSigningOut();

    expect(isSigningOut()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's own abort working", () => {
    const own = new AbortController();
    const signal = withSigningOutSignal(own.signal);

    own.abort();

    expect(signal.aborted).toBe(true);
    expect(isSigningOut()).toBe(false);
  });

  it("hands out an already aborted signal after sign-out started", () => {
    startSigningOut();

    expect(signingOutSignal().aborted).toBe(true);
    expect(withSigningOutSignal(undefined).aborted).toBe(true);
  });
});
