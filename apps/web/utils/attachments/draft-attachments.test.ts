import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { resolveDraftAttachmentsWithFailures } from "./draft-attachments";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  hasAccess: vi.fn(),
}));
vi.mock("@/utils/premium/server", () => ({ checkHasAccess: mocks.hasAccess }));
vi.mock("@/utils/drive/provider", () => ({
  createDriveProviderWithRefresh: async () => ({
    downloadFile: mocks.downloadFile,
  }),
}));

const logger = createTestLogger();
const LEASE = {
  driveConnectionId: "drive-1",
  fileId: "file-1",
  filename: "lease.pdf",
  mimeType: "application/pdf",
};
const PLAN = { ...LEASE, fileId: "file-2", filename: "floorplan.pdf" };

describe("resolveDraftAttachmentsWithFailures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasAccess.mockResolvedValue(true);
    prisma.driveConnection.findMany.mockResolvedValue([
      { id: "drive-1", provider: "google", isConnected: true },
    ] as never);
  });

  // The user was told these files go with the reply: a Drive failure must
  // say which, not quietly send without them.
  it("names each file it couldn't fetch", async () => {
    mocks.downloadFile.mockImplementation(async (fileId: string) => {
      if (fileId === "file-2") throw new Error("Drive is down");
      return {
        file: { name: "lease.pdf", mimeType: "application/pdf" },
        content: Buffer.from("pdf"),
      };
    });

    const result = await resolveDraftAttachmentsWithFailures({
      emailAccountId: "account-1",
      userId: "user-1",
      selectedAttachments: [LEASE, PLAN],
      logger,
    });

    expect(result.attachments.map((file) => file.filename)).toEqual([
      "lease.pdf",
    ]);
    expect(result.failed).toEqual([PLAN]);
  });

  it("counts every file as failed when its Drive is disconnected", async () => {
    prisma.driveConnection.findMany.mockResolvedValue([]);

    const result = await resolveDraftAttachmentsWithFailures({
      emailAccountId: "account-1",
      userId: "user-1",
      selectedAttachments: [LEASE],
      logger,
    });

    expect(result).toEqual({ attachments: [], failed: [LEASE] });
  });
});
