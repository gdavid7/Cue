import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import AdminFeedbackPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: { ADMINS: ["founder@example.com"] },
}));

describe("/admin/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.feedback.findMany.mockResolvedValue([]);
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access and loads no feedback when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminFeedbackPage();

    expect(page.props.title).toBe("No Access");
    expect(prisma.feedback.findMany).not.toHaveBeenCalled();
  });

  it("lists feedback newest first for the founder", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });

    const page = await AdminFeedbackPage();

    expect(page.props.title).toBeUndefined();
    expect(prisma.feedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });
});
