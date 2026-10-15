import { afterEach, describe, expect, it, vi } from "vitest";
import { readQaOutlookEmail } from "./qa-mailbox";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readQaOutlookEmail", () => {
  it("is not configured without the secret", () => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", "");
    expect(readQaOutlookEmail("qa@gmail.com")).toBeNull();
  });

  it("reads the Outlook QA address in lower case", () => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", " Cue.QA.Outlook@Outlook.com ");
    expect(readQaOutlookEmail("qa@gmail.com")).toBe(
      "cue.qa.outlook@outlook.com",
    );
  });

  it.each([
    "not-an-address",
    "qa@gmail.com",
    "a@outlook.com, b@outlook.com",
  ])("refuses %s, which would send probes somewhere else", (value) => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", value);
    expect(() => readQaOutlookEmail("qa@gmail.com")).toThrow(
      /CUE_QA_OUTLOOK_EMAIL/,
    );
  });
});
