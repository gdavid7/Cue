import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { notifyAdminsOfAccessRequest } from "@/utils/access/notify-admins";

const { mockDeliver } = vi.hoisted(() => ({ mockDeliver: vi.fn() }));

vi.mock("@inboxzero/transactional-email/src/delivery", () => ({
  deliverTransactionalEmail: mockDeliver,
}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BRAND_NAME: "Cue",
    NEXT_PUBLIC_BASE_URL: "https://cue.example",
    ADMINS: ["founder@example.com", "second@example.com"],
    RESEND_FROM_EMAIL: "Cue <hi@cue.example>",
  },
}));

const logger = createScopedLogger("notify-admins-test");
const request = { requestId: "r1", email: "new@gmail.com", logger };

describe("notifyAdminsOfAccessRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one idempotent email to every admin", async () => {
    mockDeliver.mockResolvedValue({ messageId: "m1" });

    await notifyAdminsOfAccessRequest(request);

    expect(mockDeliver).toHaveBeenCalledTimes(1);
    const [message, options] = mockDeliver.mock.calls[0];
    expect(message.to).toEqual(["founder@example.com", "second@example.com"]);
    expect(message.subject).toBe("New Cue access request");
    expect(message.html).toContain("Requested by: new@gmail.com");
    expect(options).toEqual({ idempotencyKey: "access-request-notify:r1" });
  });

  it("swallows a delivery failure", async () => {
    mockDeliver.mockRejectedValue(new Error("resend down"));

    await expect(notifyAdminsOfAccessRequest(request)).resolves.toBeUndefined();
  });

  it("swallows unconfigured email", async () => {
    mockDeliver.mockResolvedValue(null);

    await expect(notifyAdminsOfAccessRequest(request)).resolves.toBeUndefined();
  });
});
