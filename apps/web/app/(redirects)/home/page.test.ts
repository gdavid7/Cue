import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirectToEmailAccountPath: vi.fn(),
}));

vi.mock("@/utils/account", () => ({
  redirectToEmailAccountPath: mocks.redirectToEmailAccountPath,
}));

import HomePage from "./page";

describe("HomePage", () => {
  it("sends an account-less /home to the account's Today, keeping its query", async () => {
    const searchParams = { accounts: "all" };

    await HomePage({ searchParams: Promise.resolve(searchParams) });

    expect(mocks.redirectToEmailAccountPath).toHaveBeenCalledWith(
      "/home",
      searchParams,
    );
  });
});
