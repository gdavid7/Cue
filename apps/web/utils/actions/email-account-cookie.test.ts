import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_EMAIL_ACCOUNT_COOKIE } from "@/utils/cookies";
import { auth } from "@/utils/auth";
import { clearLastEmailAccountAction } from "./email-account-cookie";

const { cookiesDelete } = vi.hoisted(() => ({
  cookiesDelete: vi.fn(),
}));

vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "primary@example.com" },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ delete: cookiesDelete })),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

describe("clearLastEmailAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the cookie after sign-out has already ended the session", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);

    const result = await clearLastEmailAccountAction();

    expect(result?.serverError).toBeUndefined();
    expect(cookiesDelete).toHaveBeenCalledWith(LAST_EMAIL_ACCOUNT_COOKIE);
  });
});
