import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import AdminAccessPage from "./page";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: {
    ADMINS: ["founder@example.com"],
    NEXT_PUBLIC_BASE_URL: "https://cue.example",
    AUTH_WAITLIST_ENABLED: false,
  },
}));

describe("/admin/access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.accessRequest.findMany.mockResolvedValue([]);
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("shows No Access and loads no requests when %s", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const page = await AdminAccessPage();

    expect(page.props.title).toBe("No Access");
    expect(prisma.accessRequest.findMany).not.toHaveBeenCalled();
  });

  it("lists requests for the founder", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com", name: "Dee" },
    });

    const page = await AdminAccessPage();

    expect(page.props.title).toBeUndefined();
    expect(prisma.accessRequest.findMany).toHaveBeenCalledTimes(1);
  });
});
