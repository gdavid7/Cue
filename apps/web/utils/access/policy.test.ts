import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  assertSignUpAllowed,
  isApprovedForAccess,
  normalizeAccessEmail,
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
const google = { provider: "google", emailVerified: true } as const;

describe("normalizeAccessEmail", () => {
  it("matches Gmail addresses the way Gmail does", () => {
    expect(normalizeAccessEmail(" Jane.Doe@Gmail.com ")).toBe(
      "janedoe@gmail.com",
    );
    expect(normalizeAccessEmail("jane.doe+cue@googlemail.com")).toBe(
      "janedoe@gmail.com",
    );
  });

  it("leaves other domains' dots alone", () => {
    expect(normalizeAccessEmail("Jane.Doe@School.edu")).toBe(
      "jane.doe@school.edu",
    );
  });
});

describe("isApprovedForAccess", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("approves an approved request regardless of case", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      isApprovedForAccess(" Friend@Gmail.com ", closed),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: { in: ["friend@gmail.com"] },
          status: "APPROVED",
        }),
      }),
    );
  });

  it("matches an approval made with dots against a sign-in without them", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      isApprovedForAccess("jane.doe@googlemail.com", closed),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          // The raw form also matches rows stored before canonical addresses.
          email: { in: ["janedoe@gmail.com", "jane.doe@googlemail.com"] },
        }),
      }),
    );
  });

  it("blocks an address with no approved request", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue(null);
    await expect(
      isApprovedForAccess("stranger@gmail.com", closed),
    ).resolves.toBe(false);
  });

  it("always lets admins in without a request, dots or not", async () => {
    await expect(
      isApprovedForAccess("f.o.under@gmail.com", {
        ...closed,
        admins: ["founder@gmail.com"],
      }),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findFirst).not.toHaveBeenCalled();
  });

  it("keeps people on AUTH_ALLOWED_EMAILS approved", async () => {
    const policy = { ...closed, allowedEmails: ["friend@gmail.com"] };
    await expect(
      isApprovedForAccess("Fri.end@gmail.com", policy),
    ).resolves.toBe(true);
    expect(prisma.accessRequest.findFirst).not.toHaveBeenCalled();
  });

  // A domain list auto-approves everyone at it; with the waitlist on, every
  // person is approved individually.
  it("ignores AUTH_ALLOWED_EMAIL_DOMAINS while the waitlist is on", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue(null);
    const policy = { ...closed, allowedDomains: ["school.edu"] };

    await expect(
      isApprovedForAccess("student@school.edu", policy),
    ).resolves.toBe(false);
    await expect(
      isApprovedForAccess("student@school.edu", {
        ...policy,
        waitlistEnabled: false,
      }),
    ).resolves.toBe(true);
  });
});

describe("assertSignUpAllowed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps sign-up open with the waitlist off and no allow-list", async () => {
    await expect(
      assertSignUpAllowed(
        { email: "anyone@outlook.com", provider: "microsoft" },
        { ...closed, waitlistEnabled: false },
      ),
    ).resolves.toBeUndefined();
    expect(prisma.accessRequest.findFirst).not.toHaveBeenCalled();
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
  });

  it("with the waitlist off, an allow-list still blocks strangers and records their request", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue(null);
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r1" } as never);

    await expect(
      assertSignUpAllowed(
        { email: "stranger@gmail.com", ...google },
        { ...closed, waitlistEnabled: false, allowedEmails: ["a@gmail.com"] },
      ),
    ).rejects.toThrow("signup_not_allowed");
    // The "You're not in yet" page says a request was saved, so it must be.
    expect(prisma.accessRequest.create).toHaveBeenCalledTimes(1);
  });

  it("with the waitlist off, an allow-list still admits people approved on /admin/access", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed(
        { email: "friend@gmail.com", ...google },
        { ...closed, waitlistEnabled: false, allowedEmails: ["a@gmail.com"] },
      ),
    ).resolves.toBeUndefined();
  });

  it("closes sign-up with the waitlist on, even with an empty allow-list", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue(null);
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r1" } as never);

    await expect(
      assertSignUpAllowed(
        { email: "Stranger@gmail.com", name: "S", ...google },
        closed,
      ),
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

  it("lets an approved Google account sign up", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed({ email: "friend@gmail.com", ...google }, closed),
    ).resolves.toBeUndefined();
    expect(prisma.accessRequest.create).not.toHaveBeenCalled();
  });

  it("lets an approved Apple account with a verified email sign up", async () => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed(
        { email: "friend@gmail.com", provider: "apple", emailVerified: true },
        closed,
      ),
    ).resolves.toBeUndefined();
  });

  // Microsoft's email claim can be set by the tenant, so it doesn't prove the
  // person owns the approved address.
  it.each([
    { provider: "microsoft", emailVerified: true },
    { provider: "sso", emailVerified: true },
    { provider: undefined, emailVerified: true },
    { provider: "google", emailVerified: false },
  ])("refuses an approved address claimed by $provider (verified: $emailVerified)", async (identity) => {
    prisma.accessRequest.findFirst.mockResolvedValue({
      status: "APPROVED",
    } as never);

    await expect(
      assertSignUpAllowed(
        { email: "friend@gmail.com", ...identity },
        { ...closed, admins: ["friend@gmail.com"] },
      ),
    ).rejects.toThrow("signup_not_allowed");
    // An unproven claim isn't recorded as that person's request either.
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

  it("stores Gmail addresses in their canonical form", async () => {
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    prisma.accessRequest.create.mockResolvedValue({ id: "r2" } as never);

    await recordAccessRequest({
      email: "Jane.Doe@googlemail.com",
      source: "form",
    });

    expect(prisma.accessRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "janedoe@gmail.com" }),
      }),
    );
  });
});
