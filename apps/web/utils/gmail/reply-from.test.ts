import { describe, expect, it } from "vitest";
import { getGmailReplyFrom } from "./reply-from";

const sendAs = [
  {
    email: "dana@gmail.com",
    displayName: "Dana Park",
    isDefault: true,
    signature: "",
  },
  {
    email: "dana.park@school.edu",
    displayName: "Dana Park (School)",
    isDefault: false,
    signature: "",
    verificationStatus: "accepted",
  },
  {
    email: "hello@dana.dev",
    isDefault: false,
    signature: "",
    verificationStatus: "accepted",
  },
  {
    email: "pending@dana.dev",
    displayName: "Pending",
    isDefault: false,
    signature: "",
    verificationStatus: "pending",
  },
];

describe("getGmailReplyFrom", () => {
  it("replies from the alias the message was sent to", () => {
    expect(
      getGmailReplyFrom(
        {
          from: "Teacher <teacher@school.edu>",
          to: "Dana Park <dana.park@school.edu>",
        },
        sendAs,
      ),
    ).toBe('"Dana Park (School)" <dana.park@school.edu>');
  });

  it("replies from an alias that was only copied", () => {
    expect(
      getGmailReplyFrom(
        {
          from: "teacher@school.edu",
          to: "class@school.edu",
          cc: "Someone <someone@example.com>, dana.park@school.edu",
        },
        sendAs,
      ),
    ).toBe('"Dana Park (School)" <dana.park@school.edu>');
  });

  it("falls back to the alias the message was delivered to", () => {
    expect(
      getGmailReplyFrom(
        {
          from: "list@example.com",
          to: "list@example.com",
          "delivered-to": "dana.park@school.edu",
        },
        sendAs,
      ),
    ).toBe('"Dana Park (School)" <dana.park@school.edu>');
  });

  it("matches addresses regardless of case", () => {
    expect(
      getGmailReplyFrom(
        { from: "teacher@school.edu", to: "Dana.Park@School.EDU" },
        sendAs,
      ),
    ).toBe('"Dana Park (School)" <dana.park@school.edu>');
  });

  it("keeps the default address when no alias received the message", () => {
    expect(
      getGmailReplyFrom(
        { from: "teacher@school.edu", to: "class@school.edu" },
        sendAs,
      ),
    ).toBeUndefined();
  });

  it("keeps the default address when the message went to it first", () => {
    expect(
      getGmailReplyFrom(
        {
          from: "friend@example.com",
          to: "dana@gmail.com",
          cc: "dana.park@school.edu",
        },
        sendAs,
      ),
    ).toBeUndefined();
  });

  it("follows up from the alias your own message was sent from", () => {
    expect(
      getGmailReplyFrom(
        {
          from: "Dana Park (School) <dana.park@school.edu>",
          to: "teacher@school.edu",
        },
        sendAs,
      ),
    ).toBe('"Dana Park (School)" <dana.park@school.edu>');
  });

  it("names an alias without a display name after the account", () => {
    expect(
      getGmailReplyFrom(
        { from: "client@example.com", to: "hello@dana.dev" },
        sendAs,
      ),
    ).toBe('"Dana Park" <hello@dana.dev>');
  });

  it("quotes a display name that would otherwise split the address", () => {
    expect(
      getGmailReplyFrom({ from: "a@example.com", to: "dana.park@school.edu" }, [
        {
          email: "dana.park@school.edu",
          displayName: 'Park, Dana "DP"',
          isDefault: false,
          signature: "",
        },
      ]),
    ).toBe('"Park, Dana \\"DP\\"" <dana.park@school.edu>');
  });

  it("does not reply from an alias Gmail has not verified", () => {
    expect(
      getGmailReplyFrom(
        { from: "client@example.com", to: "pending@dana.dev" },
        sendAs,
      ),
    ).toBeUndefined();
  });
});
