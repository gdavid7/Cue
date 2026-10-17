import { afterEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import { deleteDraft, getDraft } from "@/utils/gmail/draft";

// Drafts the user sent or deleted come back as Gmail 404 notFound; these
// tests run the real retry wrapper to check that stays out of the warn logs.
describe("gmail/draft with a draft that no longer exists", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null from getDraft without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gmail = gmailWith({ get: vi.fn().mockRejectedValue(notFound()) });

    await expect(getDraft("r-1", gmail)).resolves.toBeNull();

    expect(warn).not.toHaveBeenCalled();
  });

  it("skips deleting a draft that was deleted in between without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gmail = gmailWith({
      get: vi.fn().mockResolvedValue({
        data: {
          id: "r-1",
          message: { id: "m-1", threadId: "t-1", labelIds: ["DRAFT"] },
        },
      }),
      delete: vi.fn().mockRejectedValue(notFound()),
    });

    await expect(deleteDraft(gmail, "r-1")).resolves.toBe(false);

    expect(warn).not.toHaveBeenCalled();
  });
});

function gmailWith(drafts: Record<string, unknown>) {
  return { users: { drafts } } as unknown as gmail_v1.Gmail;
}

function notFound() {
  return Object.assign(new Error("Requested entity was not found."), {
    status: 404,
    code: 404,
    errors: [
      { reason: "notFound", message: "Requested entity was not found." },
    ],
  });
}
