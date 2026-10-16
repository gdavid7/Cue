// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRule } from "./useRule";

const swr = vi.hoisted(() => ({ keys: [] as unknown[] }));

vi.mock("swr", () => ({
  default: (key: unknown) => {
    swr.keys.push(key);
    return { data: undefined };
  },
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  // A chat working in another account renders its cards in that account.
  useAccount: () => ({ emailAccountId: "chat-account" }),
}));

describe("useRule", () => {
  it("reads the rule through the account it is shown in, not the page's", () => {
    renderHook(() => useRule("rule-1"));

    expect(swr.keys.at(-1)).toEqual(["/api/user/rules/rule-1", "chat-account"]);
  });
});
