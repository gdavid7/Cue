import { describe, expect, it } from "vitest";
import { isSidebarRowActive } from "./pending-navigation";

const pending = { href: "/account-1/home", from: "/mail/u/0/inbox" };

describe("isSidebarRowActive", () => {
  it("follows the open view when nothing is pending", () => {
    expect(
      isSidebarRowActive({
        active: true,
        href: "/mail/u/0/inbox",
        pending: null,
        pathname: "/mail/u/0/inbox",
      }),
    ).toBe(true);
  });

  it("moves the highlight to the clicked row while its route loads", () => {
    const row = (href: string, active: boolean) =>
      isSidebarRowActive({
        active,
        href,
        pending,
        pathname: "/mail/u/0/inbox",
      });
    expect(row("/account-1/home", false)).toBe(true);
    expect(row("/mail/u/0/inbox", true)).toBe(false);
  });

  it("lets the open view decide again once the address has changed", () => {
    expect(
      isSidebarRowActive({
        active: false,
        href: "/account-1/home",
        pending,
        pathname: "/mail/u/0/sent",
      }),
    ).toBe(false);
    expect(
      isSidebarRowActive({
        active: true,
        href: "/mail/u/0/sent",
        pending,
        pathname: "/mail/u/0/sent",
      }),
    ).toBe(true);
  });
});
