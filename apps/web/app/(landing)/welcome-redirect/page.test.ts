import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findUser: vi.fn(),
  updateUsers: vi.fn(),
  redirectToEmailAccountPath: vi.fn((path: string) => {
    throw new Error(`account-redirect:${path}`);
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  registerUtmTracking: vi.fn(),
}));

vi.mock("@/utils/auth", () => ({
  auth: () => mocks.auth(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    user: {
      findUnique: (...args: Parameters<typeof mocks.findUser>) =>
        mocks.findUser(...args),
      updateMany: (...args: Parameters<typeof mocks.updateUsers>) =>
        mocks.updateUsers(...args),
    },
  },
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));

vi.mock("@/app/(landing)/welcome/utms", () => ({
  registerUtmTracking: mocks.registerUtmTracking,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mocks.redirect(url),
}));

vi.mock("@/utils/account", () => ({
  redirectToEmailAccountPath: (path: string) =>
    mocks.redirectToEmailAccountPath(path),
}));

import WelcomeRedirectPage from "./page";

describe("WelcomeRedirectPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("sends a new user straight to their inbox and marks onboarding complete", async () => {
    mocks.findUser.mockResolvedValue({ completedOnboardingAt: null });

    await expect(WelcomeRedirectPage()).rejects.toThrow(
      "account-redirect:/mail",
    );

    expect(mocks.updateUsers).toHaveBeenCalledWith({
      where: { id: "user-1", completedOnboardingAt: null },
      data: { completedOnboardingAt: expect.any(Date) },
    });
    expect(mocks.registerUtmTracking).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sends a returning user to their inbox without touching the user row", async () => {
    mocks.findUser.mockResolvedValue({
      completedOnboardingAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(WelcomeRedirectPage()).rejects.toThrow(
      "account-redirect:/mail",
    );

    expect(mocks.updateUsers).not.toHaveBeenCalled();
    expect(mocks.registerUtmTracking).not.toHaveBeenCalled();
  });

  it("sends signed-out visitors to login", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(WelcomeRedirectPage()).rejects.toThrow("redirect:/login");
    expect(mocks.findUser).not.toHaveBeenCalled();
  });
});
