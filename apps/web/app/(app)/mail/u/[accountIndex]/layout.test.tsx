import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getOrderedEmailAccountIds: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/utils/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("@/utils/mail-url.server", () => ({
  getOrderedEmailAccountIds: (userId: string) =>
    mocks.getOrderedEmailAccountIds(userId),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => mocks.redirect(url),
}));
// The screen itself is out of scope; only the route's gatekeeping is tested.
vi.mock("@/app/(app)/[emailAccountId]/mail/MailScreen", () => ({
  MailScreen: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailScreenLayout", () => ({
  MailScreenLayout: ({ children }: { children: React.ReactNode }) => children,
}));

import MailRouteLayout from "./layout";

function renderAt(accountIndex: string) {
  return MailRouteLayout({
    children: null,
    params: Promise.resolve({ accountIndex }),
  });
}

describe("MailRouteLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getOrderedEmailAccountIds.mockResolvedValue(["acc_a", "acc_b"]);
  });

  it("opens one of the signed-in user's own accounts", async () => {
    await expect(renderAt("1")).resolves.toBeTruthy();
    expect(mocks.getOrderedEmailAccountIds).toHaveBeenCalledWith("user-1");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each([
    "2",
    "99",
    "abc",
    "-1",
  ])("sends /mail/u/%s, which names no account of theirs, to the first inbox", async (accountIndex) => {
    await expect(renderAt(accountIndex)).rejects.toThrow(
      "redirect:/mail/u/0/inbox",
    );
  });

  it("asks a signed-out visitor to log in", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(renderAt("0")).rejects.toThrow("redirect:/login");
  });

  it("sends a user without a mailbox to connect one", async () => {
    mocks.getOrderedEmailAccountIds.mockResolvedValue([]);
    await expect(renderAt("0")).rejects.toThrow("redirect:/connect-mailbox");
  });
});
