import { describe, expect, it } from "vitest";
import {
  parseOtherAccountEmailId,
  toOtherAccountEmailId,
} from "./other-account-email-id";

describe("other-account email ids", () => {
  it("carries the account an email belongs to alongside its provider id", () => {
    const id = toOtherAccountEmailId("account-2", "18c1f0a2b3");

    expect(parseOtherAccountEmailId(id)).toEqual({
      emailAccountId: "account-2",
      id: "18c1f0a2b3",
    });
  });

  it("keeps an Outlook id intact, whatever characters it holds", () => {
    const outlookId = "AAMkADAwATM0MDAAMS1hNjRiLWQ1ZDctMDACLTAwCgBGAAAD=";

    expect(
      parseOtherAccountEmailId(toOtherAccountEmailId("account-2", outlookId)),
    ).toEqual({ emailAccountId: "account-2", id: outlookId });
  });

  it("reads a plain provider id as belonging to no other account", () => {
    expect(parseOtherAccountEmailId("18c1f0a2b3")).toBeNull();
    expect(parseOtherAccountEmailId("AAMkADAw=")).toBeNull();
  });

  it("does not read a malformed prefix as another account's email", () => {
    expect(parseOtherAccountEmailId("acct:")).toBeNull();
    expect(parseOtherAccountEmailId("acct::18c1")).toBeNull();
    expect(parseOtherAccountEmailId("acct:account-2:")).toBeNull();
  });
});
