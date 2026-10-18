import { describe, expect, it } from "vitest";
import { onePerExternalAccount } from "@/utils/user/owned-by-same-user";

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
