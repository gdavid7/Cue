import { describe, expect, it } from "vitest";
import { mailEngineConnectionCopy } from "./connection-notice";

describe("mailEngineConnectionCopy", () => {
  it("offers a one-click sign-in when Gmail access has expired", () => {
    expect(mailEngineConnectionCopy("blocked_auth", "google")).toEqual({
      title: "Sign in again to reconnect Gmail",
      description:
        "Google signed Cue out, so new mail is paused. Your mail and settings are still here.",
      action: "Sign in again",
    });
  });

  it("names the provider for other mailboxes", () => {
    expect(mailEngineConnectionCopy("blocked_auth", "microsoft")?.title).toBe(
      "Sign in again to reconnect Outlook",
    );
  });

  it("explains automatic retry while the mailbox is offline", () => {
    expect(mailEngineConnectionCopy("offline", "google")).toEqual({
      title: "Can't reach your mailbox right now.",
      description:
        "Showing the mail Cue already has. It catches up on its own.",
    });
  });

  it("is silent while the mailbox is ready", () => {
    expect(mailEngineConnectionCopy("ready", "google")).toBeUndefined();
    expect(mailEngineConnectionCopy(undefined, "google")).toBeUndefined();
  });
});
