import { describe, expect, it } from "vitest";
import {
  importantPeopleIndex,
  normalizeImportantPersonAddress,
  supportsImportantPeople,
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

  it("keys by the address, never by a display name that looks like one", () => {
    expect(
      normalizeImportantPersonAddress('"dana@example.com" <x@evil.com>'),
    ).toBe("x@evil.com");
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
    expect(index.has("acc-1", '"dana@example.com" <x@evil.com>')).toBe(false);
  });
});

describe("supportsImportantPeople", () => {
  const methods = {
    queryImportantPeople: async () => [],
    setImportantPerson: async () => undefined,
  };

  it("needs both methods reported and answered", () => {
    expect(
      supportsImportantPeople({
        capabilities: [
          "method:queryImportantPeople",
          "method:setImportantPerson",
        ],
        ...methods,
      }),
    ).toBe(true);
    // An engine that predates them reports the baseline.
    expect(supportsImportantPeople(methods)).toBe(false);
    // A relay that can't carry them, like desktop IPC v1.
    expect(
      supportsImportantPeople({
        capabilities: [
          "method:queryImportantPeople",
          "method:setImportantPerson",
        ],
      }),
    ).toBe(false);
    expect(supportsImportantPeople(null)).toBe(false);
  });
});
