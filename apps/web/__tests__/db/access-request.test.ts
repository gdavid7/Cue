import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import {
  assertSignUpAllowed,
  isApprovedForAccess,
  recordAccessRequest,
} from "@/utils/access/policy";

vi.mock("@/utils/posthog", () => ({ posthogCaptureEvent: vi.fn() }));

const email = "access-request-db-test@example.com";
const waitlistOn = {
  waitlistEnabled: true,
  admins: [],
  allowedEmails: [],
  allowedDomains: [],
};

describe.skipIf(!process.env.RUN_DB_TESTS)(
  "access requests (real database)",
  () => {
    beforeEach(async () => {
      await prisma.accessRequest.deleteMany({ where: { email } });
      await prisma.user.deleteMany({ where: { email } });
    });

    afterAll(async () => {
      await prisma.accessRequest.deleteMany({ where: { email } });
    });

    it("a blocked sign-in, tried twice, leaves one pending request and no user", async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          assertSignUpAllowed(
            { email: ` ${email.toUpperCase()} ` },
            waitlistOn,
          ),
        ).rejects.toThrow("signup_not_allowed");
      }

      const requests = await prisma.accessRequest.findMany({
        where: { email },
      });
      expect(requests).toEqual([
        expect.objectContaining({
          status: "PENDING",
          source: "google_sign_in",
        }),
      ]);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it("never turns a decision back into a pending request", async () => {
      await prisma.accessRequest.create({
        data: { email, source: "admin", status: "APPROVED" },
      });

      await recordAccessRequest({ email, source: "form" });

      const request = await prisma.accessRequest.findUniqueOrThrow({
        where: { email },
      });
      expect(request.status).toBe("APPROVED");
      await expect(isApprovedForAccess(email, waitlistOn)).resolves.toBe(true);
      await expect(
        assertSignUpAllowed({ email }, waitlistOn),
      ).resolves.toBeUndefined();
    });
  },
);
