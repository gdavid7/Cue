import { describe, expect, it } from "vitest";
import { showCopiesOnce } from "./cross-account-copies";

type Row = { accountId: string; messageId: string; at: number };

describe("showCopiesOnce", () => {
  const rows: Row[] = [
    { accountId: "home", messageId: "<same@example.com>", at: 2 },
    { accountId: "work", messageId: "<same@example.com>", at: 1 },
  ];

  it("keeps the first copy when the preferred account's arrived at another time", () => {
    const [shown] = showCopiesOnce(rows, (row) => row, "work");
    expect(shown.row.accountId).toBe("home");
    expect(shown.copies.map((copy) => copy.accountId)).toEqual(["work"]);
  });

  it("shows the preferred account's copy whenever it has one, with alwaysPrefer", () => {
    const [shown] = showCopiesOnce(rows, (row) => row, "work", {
      alwaysPrefer: true,
    });
    expect(shown.row.accountId).toBe("work");
    expect(shown.copies.map((copy) => copy.accountId)).toEqual(["home"]);
  });
});
