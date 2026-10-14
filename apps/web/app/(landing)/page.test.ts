import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findUser: vi.fn(),
  redirectToEmailAccountPath: vi.fn((path: string) => {
    throw new Error(`account-redirect:${path}`);
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/utils/auth", () => ({
  auth: () => mocks.auth(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    user: {
      findUnique: (...args: Parameters<typeof mocks.findUser>) =>
        mocks.findUser(...args),
    },
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mocks.redirect(url),
}));

vi.mock("@/utils/account", () => ({
  redirectToEmailAccountPath: (...args: [string, unknown, unknown]) =>
    mocks.redirectToEmailAccountPath(...args),
}));

import RootPage from "./page";

describe("RootPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("sends an onboarded user straight to their mailbox, reusing the session", async () => {
    mocks.findUser.mockResolvedValue({
      completedOnboardingAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(RootPage()).rejects.toThrow("account-redirect:/mail");

    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(mocks.redirectToEmailAccountPath).toHaveBeenCalledWith(
      "/mail",
      undefined,
      { user: { id: "user-1" } },
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("leaves first runs to the welcome redirect", async () => {
    mocks.findUser.mockResolvedValue({ completedOnboardingAt: null });

    await expect(RootPage()).rejects.toThrow("redirect:/welcome-redirect");
    expect(mocks.redirectToEmailAccountPath).not.toHaveBeenCalled();
  });

  it("leaves sessions without a user row to the welcome redirect", async () => {
    mocks.findUser.mockResolvedValue(null);

    await expect(RootPage()).rejects.toThrow("redirect:/welcome-redirect");
  });

  it("sends signed-out visitors to login", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(RootPage()).rejects.toThrow("redirect:/login");
    expect(mocks.findUser).not.toHaveBeenCalled();
  });
});
