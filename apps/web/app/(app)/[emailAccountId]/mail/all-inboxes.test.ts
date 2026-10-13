import { describe, expect, it } from "vitest";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { getAllInboxesAccounts, isAccountSectionOpen } from "./all-inboxes";

describe("isAccountSectionOpen", () => {
  it("opens sections by default only while there are two accounts or fewer", () => {
    expect(isAccountSectionOpen({ storedOpen: null, accountCount: 2 })).toBe(
      true,
    );
    expect(isAccountSectionOpen({ storedOpen: null, accountCount: 3 })).toBe(
      false,
    );
  });

  it("keeps the user's own choice whatever the account count", () => {
    expect(isAccountSectionOpen({ storedOpen: true, accountCount: 5 })).toBe(
      true,
    );
    expect(isAccountSectionOpen({ storedOpen: false, accountCount: 2 })).toBe(
      false,
    );
  });
});

describe("getAllInboxesAccounts", () => {
  it("keeps connected accounts chosen for All inboxes, in account order", () => {
    expect(
      getAllInboxesAccounts([
        emailAccount({ id: "work" }),
        emailAccount({ id: "excluded", includeInAllAccounts: false }),
        emailAccount({
          id: "disconnected",
          disconnectedAt: "2026-01-01T00:00:00.000Z",
        }),
        emailAccount({ id: "personal" }),
      ]).map((account) => account.id),
    ).toEqual(["work", "personal"]);
  });
});

function emailAccount({
  id,
  includeInAllAccounts = true,
  disconnectedAt = null,
}: {
  id: string;
  includeInAllAccounts?: boolean;
  disconnectedAt?: string | null;
}): GetEmailAccountsResponse["emailAccounts"][number] {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    image: null,
    accountId: `auth-${id}`,
    includeInAllAccounts,
    account: { disconnectedAt, provider: "google" },
    user: { name: null, image: null, email: `${id}@example.com` },
    isPrimary: false,
    providerRateLimit: null,
  } as GetEmailAccountsResponse["emailAccounts"][number];
}
