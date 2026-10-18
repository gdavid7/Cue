import { describe, expect, it } from "vitest";
import {
  onePerExternalAccount,
  ownedBySameUser,
} from "@/utils/user/owned-by-same-user";

describe("ownedBySameUser", () => {
  it("refuses a missing account id, which would otherwise match every person's rows", () => {
    expect(() => ownedBySameUser(undefined as unknown as string)).toThrow();
    expect(() => ownedBySameUser("")).toThrow();
  });

  it("matches rows of any mailbox belonging to the account's owner", () => {
    expect(ownedBySameUser("work")).toEqual({
      emailAccount: { user: { emailAccounts: { some: { id: "work" } } } },
    });
  });
});

describe("onePerExternalAccount", () => {
  it("keeps one row per login connected from several mailboxes, and every mailbox picks the same one", () => {
    const rows = [
      { id: "b", provider: "google", email: "Me@Work.com", isConnected: true },
      { id: "a", provider: "google", email: "me@work.com", isConnected: true },
      {
        id: "c",
        provider: "microsoft",
        email: "me@work.com",
        isConnected: true,
      },
    ];

    expect(onePerExternalAccount(rows).map((row) => row.id)).toEqual([
      "a",
      "c",
    ]);
    expect(
      onePerExternalAccount([...rows].reverse()).map((row) => row.id),
    ).toEqual(["c", "a"]);
  });

  it("prefers a connected row over a disconnected copy", () => {
    const rows = [
      { id: "a", provider: "google", email: "me@work.com", isConnected: false },
      { id: "b", provider: "google", email: "me@work.com", isConnected: true },
    ];

    expect(onePerExternalAccount(rows).map((row) => row.id)).toEqual(["b"]);
  });
});
