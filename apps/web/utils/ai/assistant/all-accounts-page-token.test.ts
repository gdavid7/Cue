import { describe, expect, it } from "vitest";
import {
  parseAllAccountsPageToken,
  searchPageTokenSchema,
  toAllAccountsPageToken,
} from "./all-accounts-page-token";

describe("all-accounts page token", () => {
  it("carries each account's own page token", () => {
    const token = toAllAccountsPageToken({
      "account-1": "GMAIL_PAGE_2",
      "account-2": "https://graph.microsoft.com/v1.0/me/messages?$skip=10",
    });

    expect(parseAllAccountsPageToken(token)).toEqual({
      "account-1": "GMAIL_PAGE_2",
      "account-2": "https://graph.microsoft.com/v1.0/me/messages?$skip=10",
    });
    expect(searchPageTokenSchema.safeParse(token).success).toBe(true);
  });

  it("is no all-accounts token for a single provider's token", () => {
    expect(parseAllAccountsPageToken("GMAIL_PAGE_2")).toBeNull();
    expect(parseAllAccountsPageToken(undefined)).toBeNull();
    expect(searchPageTokenSchema.safeParse("GMAIL_PAGE_2").success).toBe(true);
  });

  // An Outlook page token is fetched as a URL, so one inside must still be
  // Graph's own.
  it("refuses a token that carries a link outside Microsoft Graph", () => {
    const token = toAllAccountsPageToken({
      "account-2": "https://attacker.example/steal",
    });

    expect(searchPageTokenSchema.safeParse(token).success).toBe(false);
    expect(parseAllAccountsPageToken(token)).toEqual({});
  });

  it("refuses a token that does not decode", () => {
    expect(searchPageTokenSchema.safeParse("accounts:%%%").success).toBe(false);
  });
});
