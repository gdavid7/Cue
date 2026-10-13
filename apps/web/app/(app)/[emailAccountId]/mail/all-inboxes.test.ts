import { describe, expect, it } from "vitest";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { getAllInboxesAccounts } from "./all-inboxes";

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
