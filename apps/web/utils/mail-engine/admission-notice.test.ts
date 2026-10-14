import { describe, expect, it } from "vitest";
import { admissionRejectionCopy } from "./admission-notice";

describe("admissionRejectionCopy", () => {
  it("explains a full local command queue", () => {
    expect(admissionRejectionCopy("queue_full")).toBe(
      "Your earlier changes are still being saved to your mailbox. Try again in a moment.",
    );
  });

  it("explains disk pressure for blob and mailbox rejects", () => {
    expect(admissionRejectionCopy("too_large")).toBe(
      "Your device is running out of storage, so this didn't go through. Free up some space, then try again.",
    );
    expect(admissionRejectionCopy("storage_unavailable")).toBe(
      "Your device is running out of storage, so this didn't go through. Free up some space, then try again.",
    );
  });

  it("leaves other rejects to the caller", () => {
    expect(admissionRejectionCopy("invalid")).toBeUndefined();
    expect(admissionRejectionCopy("stale_selection")).toBeUndefined();
    expect(admissionRejectionCopy(undefined)).toBeUndefined();
  });
});
