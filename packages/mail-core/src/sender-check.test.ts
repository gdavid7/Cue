import { describe, expect, it } from "vitest";
import type { SenderHistory } from "./queries";
import {
  findSenderNotice,
  needsSenderHistory,
  personNameKey,
  senderAllowKey,
} from "./sender-check";

const OWN = ["me@example.com", "me@work.example"];

describe("findSenderNotice", () => {
  it("flags a familiar name from an address you have never written to", () => {
    expect(
      check({
        name: "Dana Example",
        address: "dana.example@other.test",
        history: history({ sameNameAddresses: ["dana@example.com"] }),
      }),
    ).toEqual({
      kind: "familiar-name",
      name: "Dana Example",
      address: "dana.example@other.test",
      knownAddress: "dana@example.com",
    });
  });

  it("says nothing when you have written to this address before", () => {
    expect(
      check({
        name: "Dana Example",
        address: "dana@personal.test",
        history: history({
          writtenTo: true,
          sameNameAddresses: ["dana@example.com"],
        }),
      }),
    ).toBeNull();
  });

  it("says nothing for a name you have not written to", () => {
    expect(
      check({ name: "Dana Example", address: "dana@new.test" }),
    ).toBeNull();
  });

  it("says nothing until the contact index is ready", () => {
    expect(
      check({
        name: "Dana Example",
        address: "dana@new.test",
        history: history({
          ready: false,
          sameNameAddresses: ["dana@example.com"],
        }),
      }),
    ).toBeNull();
  });

  it("flags a display name that is an address on another domain", () => {
    expect(
      check({ name: "billing@bank.example", address: "alerts@lookalike.test" }),
    ).toEqual({
      kind: "address-name",
      name: "billing@bank.example",
      address: "alerts@lookalike.test",
    });
  });

  it("accepts an address-like name on the same domain or a subdomain of it", () => {
    for (const [name, address] of [
      ["Billing@Bank.example", "billing@bank.example"],
      ["billing@bank.example", "noreply@mail.bank.example"],
      ["dana@example.com", "dana@example.com"],
    ])
      expect(check({ name, address })).toBeNull();
    // A different domain that only ends with the same letters is another one.
    expect(
      check({ name: "billing@bank.example", address: "x@evilbank.example" }),
    ).not.toBeNull();
  });

  it("never flags mail from the user's own addresses or other accounts", () => {
    for (const address of ["me@example.com", "ME@work.example"]) {
      expect(
        check({
          name: "Dana Example",
          address,
          history: history({ sameNameAddresses: ["dana@example.com"] }),
        }),
      ).toBeNull();
      expect(check({ name: "billing@bank.example", address })).toBeNull();
    }
  });

  it("allows a name and address the user marked as fine", () => {
    const input = {
      name: "Dana Example",
      address: "dana@new.test",
      history: history({ sameNameAddresses: ["dana@example.com"] }),
    };
    const allowed = new Set([senderAllowKey("DANA  example", "Dana@New.test")]);
    expect(
      check({ ...input, isAllowed: (key) => allowed.has(key) }),
    ).toBeNull();
    // Only that pair: the same name from yet another address still shows.
    expect(
      check({
        ...input,
        address: "dana@third.test",
        isAllowed: (key) => allowed.has(key),
      }),
    ).not.toBeNull();
  });

  it("allows an address-like name the user marked as fine", () => {
    const allowed = new Set([
      senderAllowKey("billing@bank.example", "alerts@lookalike.test"),
    ]);
    expect(
      check({
        name: "billing@bank.example",
        address: "alerts@lookalike.test",
        isAllowed: (key) => allowed.has(key),
      }),
    ).toBeNull();
  });
});

describe("personNameKey", () => {
  it("matches names whatever their case, spacing or accents", () => {
    expect(personNameKey("  José   ÁLVAREZ ")).toBe("jose alvarez");
    expect(personNameKey("Jose Alvarez")).toBe(personNameKey("josé álvarez"));
    expect(personNameKey('"Dana Example"')).toBe("dana example");
  });

  it("leaves out names too short to tell people apart", () => {
    for (const name of ["", "Dana", "  dana  ", "D. Example", "J R"])
      expect(personNameKey(name)).toBeNull();
  });

  it("leaves out names that are addresses", () => {
    expect(personNameKey("dana@example.com")).toBeNull();
  });
});

describe("needsSenderHistory", () => {
  it("looks a sender up only for a full name from someone else", () => {
    expect(needsSenderHistory("Dana Example", "dana@new.test", OWN)).toBe(true);
    expect(needsSenderHistory("Dana", "dana@new.test", OWN)).toBe(false);
    expect(needsSenderHistory("Me Myself", "me@example.com", OWN)).toBe(false);
  });
});

function check({
  name,
  address,
  history: senderHistory,
  isAllowed = () => false,
}: {
  name: string;
  address: string;
  history?: SenderHistory;
  isAllowed?: (key: string) => boolean;
}) {
  return findSenderNotice({
    name,
    address,
    ownAddresses: OWN,
    history: senderHistory,
    isAllowed,
  });
}

function history(input: Partial<SenderHistory> = {}): SenderHistory {
  return { ready: true, writtenTo: false, sameNameAddresses: [], ...input };
}
