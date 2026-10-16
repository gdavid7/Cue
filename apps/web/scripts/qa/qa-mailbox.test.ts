import { afterEach, describe, expect, it, vi } from "vitest";
import { readQaOutlookMailbox } from "./qa-mailbox";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readQaOutlookMailbox", () => {
  it("is not configured without the secret", () => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", "");
    expect(readQaOutlookMailbox("qa@gmail.com")).toEqual({
      status: "not_configured",
    });
  });

  it("reads the Outlook QA address in lower case", () => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", " Cue.QA.Outlook@Outlook.com ");
    expect(readQaOutlookMailbox("qa@gmail.com")).toEqual({
      status: "configured",
      email: "cue.qa.outlook@outlook.com",
    });
  });

  // Reported rather than thrown, so the Gmail steps still run.
  it.each([
    "not-an-address",
    "qa@gmail.com",
    "a@outlook.com, b@outlook.com",
  ])("calls %s misconfigured, since probes would go somewhere else", (value) => {
    vi.stubEnv("CUE_QA_OUTLOOK_EMAIL", value);
    expect(readQaOutlookMailbox("qa@gmail.com")).toEqual({
      status: "misconfigured",
      reason: expect.stringContaining("CUE_QA_OUTLOOK_EMAIL"),
    });
  });
});
