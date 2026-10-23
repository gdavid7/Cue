import { describe, expect, it } from "vitest";
import {
  importantPeopleIndex,
  normalizeImportantPersonAddress,
} from "./important-people";

describe("normalizeImportantPersonAddress", () => {
  it("reads the address out of a header and lowercases it", () => {
    expect(
      normalizeImportantPersonAddress('"Lee, Dana" <Dana@Example.com>'),
    ).toBe("dana@example.com");
    expect(normalizeImportantPersonAddress("  DANA@example.com ")).toBe(
      "dana@example.com",
    );
  });

  it("keeps the dots and plus parts that make another mailbox elsewhere", () => {
    expect(normalizeImportantPersonAddress("d.lee+work@example.com")).toBe(
      "d.lee+work@example.com",
    );
  });

  it("has nothing to key by without an address", () => {
    expect(normalizeImportantPersonAddress("Dana Lee")).toBeNull();
    expect(normalizeImportantPersonAddress("")).toBeNull();
  });
});

describe("importantPeopleIndex", () => {
  it("matches mail from a starred person only in the account it was starred in", () => {
    const index = importantPeopleIndex([
      { accountId: "acc-1", email: "dana@example.com", addedAtMs: 1 },
    ]);
    expect(index.has("acc-1", "Dana <DANA@example.com>")).toBe(true);
    expect(index.has("acc-2", "dana@example.com")).toBe(false);
    expect(index.has("acc-1", "alex@example.com")).toBe(false);
  });
});
