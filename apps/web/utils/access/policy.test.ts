import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  assertSignUpAllowed,
  isApprovedForAccess,
  recordAccessRequest,
} from "@/utils/access/policy";

vi.mock("@/utils/prisma");
vi.mock("@/utils/posthog", () => ({ posthogCaptureEvent: vi.fn() }));

const closed = {
  waitlistEnabled: true,
  admins: ["Founder@Gmail.com"],
  allowedEmails: [],
  allowedDomains: [],
};

describe("isApprovedForAccess", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("approves an approved request regardless of case", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      isApprovedForAccess(" Friend@Gmail.com ", closed),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "friend@gmail.com" } }),
    );
  });

  it.each([
    "PENDING",
    "DECLINED",
  ] as const)("blocks a %s request", async (status) => {
    prisma.accessRequest.findUnique.mockResolvedValue({ status } as never);
    await expect(isApprovedForAccess("friend@gmail.com", closed)).resolves.toBe(
      false,
    );
  });

  it("blocks an address with no request", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    await expect(
      isApprovedForAccess("stranger@gmail.com", closed),
    ).resolves.toBe(false);
  });

  it("always lets admins in without a request", async () => {
    await expect(
      isApprovedForAccess("founder@gmail.com", closed),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findUnique).not.toHaveBeenCalled();
  });

  it("keeps everyone on the existing allow-lists approved", async () => {
    const policy = {
      ...closed,
      allowedEmails: ["friend@gmail.com"],
      allowedDomains: ["school.edu"],
    };
    await expect(isApprovedForAccess("Friend@gmail.com", policy)).resolves.toBe(
      true,
    );
    await expect(
      isApprovedForAccess("student@school.edu", policy),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findUnique).not.toHaveBeenCalled();
  });
});

describe("assertSignUpAllowed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps sign-up open with the waitlist off and no allow-list", async () => {
    await expect(
      assertSignUpAllowed(
        { email: "anyone@gmail.com" },
        { ...closed, waitlistEnabled: false },
      ),
    ).resolves.toBeUndefined();
    expect(prisma.accessRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
  });

  it("with the waitlist off, an allow-list still blocks strangers and records their request", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r1" } as never);

    await expect(
      assertSignUpAllowed(
        { email: "stranger@gmail.com" },
        { ...closed, waitlistEnabled: false, allowedEmails: ["a@gmail.com"] },
      ),
    ).rejects.toThrow("signup_not_allowed");
    // The "You're not in yet" page says a request was saved, so it must be.
    expect(prisma.accessRequest.create).toHaveBeenCalledTimes(1);
  });

  it("with the waitlist off, an allow-list still admits people approved on /admin/access", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed(
        { email: "friend@gmail.com" },
        { ...closed, waitlistEnabled: false, allowedEmails: ["a@gmail.com"] },
      ),
    ).resolves.toBeUndefined();
  });

  it("closes sign-up with the waitlist on, even with an empty allow-list", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r1" } as never);

    await expect(
      assertSignUpAllowed({ email: "Stranger@gmail.com", name: "S" }, closed),
    ).rejects.toThrow("signup_not_allowed");
    expect(prisma.accessRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.accessRequest.create).toHaveBeenCalledWith({
      data: {
        email: "stranger@gmail.com",
        name: "S",
        source: "google_sign_in",
      },
      select: { id: true },
    });
  });

  it("lets an approved person sign up", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed({ email: "friend@gmail.com" }, closed),
    ).resolves.toBeUndefined();
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
  });
});

describe("recordAccessRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("never changes an existing request", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue({ id: "r1" } as never);

    await expect(
      recordAccessRequest({ email: "friend@gmail.com", source: "form" }),
    ).resolves.toEqual({ id: "r1", isRepeat: true });
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(prisma.accessRequest.update).not.toHaveBeenCalled();
  });
});
