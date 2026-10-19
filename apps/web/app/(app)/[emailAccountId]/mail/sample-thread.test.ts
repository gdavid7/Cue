import { describe, expect, it } from "vitest";
import { shouldShowSampleThread } from "@/app/(app)/[emailAccountId]/mail/sample-thread";

const base = {
  isPlainInbox: true,
  isFirstSync: false,
  isLoading: false,
  threadCount: 0,
  userLoaded: true,
  dismissed: false,
};

describe("shouldShowSampleThread", () => {
  it("shows for an empty or quiet inbox after the first sync", () => {
    expect(shouldShowSampleThread(base)).toBe(true);
    expect(shouldShowSampleThread({ ...base, threadCount: 2 })).toBe(true);
  });

  it("goes away on its own once real mail reaches the threshold", () => {
    expect(shouldShowSampleThread({ ...base, threadCount: 3 })).toBe(false);
  });

  it("waits for the first sync and for loading to settle", () => {
    expect(shouldShowSampleThread({ ...base, isFirstSync: true })).toBe(false);
    expect(shouldShowSampleThread({ ...base, isLoading: true })).toBe(false);
  });

  it("stays hidden until the dismissal setting has loaded, and once dismissed", () => {
    expect(shouldShowSampleThread({ ...base, userLoaded: false })).toBe(false);
    expect(shouldShowSampleThread({ ...base, dismissed: true })).toBe(false);
  });

  it("only appears in the plain inbox, not in search, labels, or splits", () => {
    expect(shouldShowSampleThread({ ...base, isPlainInbox: false })).toBe(
      false,
    );
  });
});
