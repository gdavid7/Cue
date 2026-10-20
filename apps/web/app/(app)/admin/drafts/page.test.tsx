import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import AdminDraftFunnelPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: { ADMINS: ["founder@example.com"] },
}));

describe("/admin/drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.executedAction.findMany.mockResolvedValue([]);
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access and reads no suggestions when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminDraftFunnelPage();

    expect(page.props.title).toBe("No Access");
    expect(prisma.executedAction.findMany).not.toHaveBeenCalled();
  });

  it("shows the funnel to the founder", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });

    const page = await AdminDraftFunnelPage();

    expect(page.props.title).toBeUndefined();
    expect(prisma.executedAction.findMany).toHaveBeenCalledTimes(1);
  });
});
