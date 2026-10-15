import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  approveAccessEmailAction,
  approveAccessRequestsAction,
  declineAccessRequestAction,
  importAllowlistAction,
  markAccessRequestNotifiedAction,
  requestAccessAction,
} from "./access";

const { mockAuth, mockCheckRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/utils/posthog", () => ({ posthogCaptureEvent: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("@/utils/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/rate-limit")>()),
  checkRateLimit: mockCheckRateLimit,
  hashRateLimitValue: (value: string) => `hash-${value}`,
}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BRAND_NAME: "Cue",
    NEXT_PUBLIC_BASE_URL: "https://cue.example",
    ADMINS: ["founder@example.com"],
    AUTH_ALLOWED_EMAILS: [" Friend@Gmail.com ", "pal@school.edu"],
    NODE_ENV: "test",
  },
}));

describe("admin access actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["signed out", null],
    [
      "a signed-in non-admin",
      { user: { id: "u2", email: "friend@example.com" } },
    ],
  ])("are refused for %s and change nothing", async (_label, session) => {
    mockAuth.mockResolvedValue(session);

    const results = await Promise.all([
      approveAccessRequestsAction({ ids: ["r1"] }),
      approveAccessEmailAction({ email: "someone@gmail.com" }),
      declineAccessRequestAction({ id: "r1" }),
      markAccessRequestNotifiedAction({ id: "r1" }),
      importAllowlistAction(),
    ]);

    for (const result of results)
      expect(result?.serverError).toBe("Unauthorized");
    expect(prisma.accessRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.accessRequest.upsert).not.toHaveBeenCalled();
    expect(prisma.accessRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.accessRequest.createMany).not.toHaveBeenCalled();
  });

  it("imports the allow-list as approved without notifying anyone", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });
    prisma.accessRequest.createMany.mockResolvedValue({ count: 1 });
    prisma.accessRequest.updateMany.mockResolvedValue({ count: 1 });

    const result = await importAllowlistAction();

    expect(result?.data).toEqual({ imported: 2 });
    expect(prisma.accessRequest.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          email: "friend@gmail.com",
          source: "allowlist",
          status: "APPROVED",
          decidedBy: "migration",
          notifiedAt: expect.any(Date),
        }),
        expect.objectContaining({ email: "pal@school.edu" }),
      ],
      skipDuplicates: true,
    });
    // Someone who asked before being listed is approved too.
    expect(prisma.accessRequest.updateMany).toHaveBeenCalledWith({
      where: {
        email: { in: ["friend@gmail.com", "pal@school.edu"] },
        status: { not: "APPROVED" },
      },
      data: expect.objectContaining({ status: "APPROVED" }),
    });
  });

  it("lets the founder approve pending requests and records who decided", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com", name: "Dee" },
    });
    prisma.accessRequest.findMany.mockResolvedValue([
      {
        id: "r1",
        email: "friend@gmail.com",
        name: null,
        createdAt: new Date(),
      },
    ] as never);
    prisma.accessRequest.updateMany.mockResolvedValue({ count: 1 });

    const result = await approveAccessRequestsAction({ ids: ["r1"] });

    expect(result?.data?.approved).toEqual([
      { id: "r1", email: "friend@gmail.com", emailed: false },
    ]);
    expect(prisma.accessRequest.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1"] } },
      data: expect.objectContaining({
        status: "APPROVED",
        decidedBy: "founder@example.com",
      }),
    });
  });

  it("only declines pending requests", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });
    prisma.accessRequest.updateMany.mockResolvedValue({ count: 0 });

    const result = await declineAccessRequestAction({ id: "approved-one" });

    expect(prisma.accessRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "approved-one", status: "PENDING" },
      }),
    );
    expect(result?.serverError).toBe("Only pending requests can be declined");
  });
});

describe("requestAccessAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(null);
    mockCheckRateLimit.mockResolvedValue({
      limited: false,
      limit: 5,
      remaining: 4,
    });
  });

  it("records a request without a session and never changes an existing one", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      id: "r1",
      status: "DECLINED",
    } as never);

    const result = await requestAccessAction({ email: " Friend@Gmail.com " });

    expect(result?.data).toEqual({ ok: true });
    expect(prisma.accessRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "friend@gmail.com" } }),
    );
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(prisma.accessRequest.update).not.toHaveBeenCalled();
  });

  it("creates a pending request for a new address", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r2" } as never);

    const result = await requestAccessAction({ email: "new@gmail.com" });

    expect(result?.data).toEqual({ ok: true });
    expect(prisma.accessRequest.create).toHaveBeenCalledWith({
      data: { email: "new@gmail.com", name: null, source: "form" },
      select: { id: true },
    });
  });

  // School and work Google accounts sign in with Google too.
  it("takes a school Google address", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r4" } as never);

    const result = await requestAccessAction({ email: "Student@School.edu" });

    expect(result?.data).toEqual({ ok: true });
    expect(prisma.accessRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "student@school.edu" }),
      }),
    );
  });

  it("refuses something that isn't an email without recording it", async () => {
    const result = await requestAccessAction({ email: "not-an-email" });

    expect(result?.validationErrors).toBeDefined();
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("takes googlemail.com addresses, stored as their Gmail form", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r3" } as never);

    const result = await requestAccessAction({
      email: "Jane.Doe@googlemail.com",
    });

    expect(result?.data).toEqual({ ok: true });
    expect(prisma.accessRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "janedoe@gmail.com" }),
      }),
    );
  });

  it("silently drops submissions that fill the hidden field", async () => {
    const result = await requestAccessAction({
      email: "bot@gmail.com",
      website: "https://spam.example",
    });

    expect(result?.data).toEqual({ ok: true });
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("asks people to wait once the rate limit is hit", async () => {
    mockCheckRateLimit.mockResolvedValue({
      limited: true,
      limit: 5,
      retryAfterSeconds: 3600,
    });

    const result = await requestAccessAction({ email: "new@gmail.com" });

    expect(result?.serverError).toBe(
      "Too many requests. Try again in a little while.",
    );
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
  });
});

describe("approveAccessEmailAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "founder@example.com" },
    });
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.upsert.mockImplementation(((args: {
      create: { email: string };
    }) =>
      Promise.resolve({
        id: "r1",
        email: args.create.email,
        name: null,
      })) as never);
  });

  it.each([
    ["a school address", " Student@School.EDU ", "student@school.edu"],
    ["a work address", "dee@company.co.uk", "dee@company.co.uk"],
    [
      "a Gmail address with dots",
      "Jane.Doe@googlemail.com",
      "janedoe@gmail.com",
    ],
  ])("approves %s, stored the way sign-in matches it", async (_label, input, stored) => {
    const result = await approveAccessEmailAction({ email: input });

    expect(result?.data).toEqual({
      id: "r1",
      email: stored,
      alreadyApproved: false,
      approved: [{ id: "r1", email: stored, emailed: false }],
    });
    expect(prisma.accessRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: stored },
        create: expect.objectContaining({
          email: stored,
          source: "admin",
          status: "APPROVED",
          decidedBy: "founder@example.com",
        }),
        update: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
  });

  it("approves someone who was declined", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      id: "r1",
      status: "DECLINED",
    } as never);

    const result = await approveAccessEmailAction({ email: "pal@gmail.com" });

    expect(result?.data?.alreadyApproved).toBe(false);
    expect(prisma.accessRequest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
  });

  it("says when someone is already in the beta and changes nothing", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      id: "r1",
      status: "APPROVED",
    } as never);

    const result = await approveAccessEmailAction({
      email: "Pal.Friend@gmail.com",
    });

    expect(result?.data).toEqual({
      id: "r1",
      email: "palfriend@gmail.com",
      alreadyApproved: true,
      approved: [],
    });
    expect(prisma.accessRequest.upsert).not.toHaveBeenCalled();
  });

  it("refuses something that isn't an email", async () => {
    const result = await approveAccessEmailAction({ email: "not an email" });

    expect(result?.validationErrors).toBeDefined();
    expect(prisma.accessRequest.upsert).not.toHaveBeenCalled();
  });
});
