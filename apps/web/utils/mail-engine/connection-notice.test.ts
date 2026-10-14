import { describe, expect, it } from "vitest";
import { mailEngineConnectionCopy } from "./connection-notice";

describe("mailEngineConnectionCopy", () => {
  it("asks the user to reconnect when auth is blocked", () => {
    expect(mailEngineConnectionCopy("blocked_auth")).toEqual({
      title: "Reconnect this account to keep getting mail",
      description:
        "Cue lost access, so new mail is paused. Nothing in your mailbox has changed.",
      action: "Reconnect",
    });
  });

  it("explains automatic retry while the mailbox is offline", () => {
    expect(mailEngineConnectionCopy("offline")).toEqual({
      title: "Can't reach your mailbox right now.",
      description:
        "Showing the mail Cue already has. It catches up on its own.",
    });
  });

  it("is silent while the mailbox is ready", () => {
    expect(mailEngineConnectionCopy("ready")).toBeUndefined();
    expect(mailEngineConnectionCopy(undefined)).toBeUndefined();
  });
});
