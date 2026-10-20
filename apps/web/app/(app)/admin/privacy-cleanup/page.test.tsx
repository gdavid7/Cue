import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminPrivacyCleanupPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/app/(app)/admin/privacy-cleanup/PrivacyCleanup", () => ({
  PrivacyCleanup: () => null,
}));
vi.mock("@/env", () => ({
  env: { ADMINS: ["founder@example.com"] },
}));

describe("/admin/privacy-cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminPrivacyCleanupPage();

    expect(page.props.title).toBe("No Access");
  });

  it("shows the cleanup to the founder", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });

    const page = await AdminPrivacyCleanupPage();

    expect(page.props.title).toBeUndefined();
  });
});
