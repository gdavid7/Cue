import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import {
  getConnectedDriveApps,
  saveAttachmentToDrive,
} from "@/utils/attachments/save-to-drive";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { uploadComposioFile } from "@/utils/mcp/providers/composio";
import { ConnectionExpiredError } from "@/utils/mcp/providers/types";

const integration = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  executeTool: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/mcp/providers/composio", () => ({
  uploadComposioFile: vi.fn(),
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => integration,
}));

const logger = createTestLogger();
const MB = 1024 * 1024;

describe("getConnectedDriveApps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integration.isConfigured.mockReturnValue(true);
  });

  it("lists only the drives the person has an active connection to", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("other-account", "one_drive"),
    ] as never);

    await expect(getConnectedDriveApps("account-1")).resolves.toEqual([
      { app: "one_drive", name: "OneDrive" },
    ]);
    expect(prisma.mcpConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          emailAccount: {
            user: { emailAccounts: { some: { id: "account-1" } } },
          },
        }),
      }),
    );
  });

  it("offers no drives when the connector service isn't configured", async () => {
    integration.isConfigured.mockReturnValue(false);

    await expect(getConnectedDriveApps("account-1")).resolves.toEqual([]);
    expect(prisma.mcpConnection.findMany).not.toHaveBeenCalled();
  });
});

describe("saveAttachmentToDrive", () => {
  const emailProvider = {
    getMessage: vi.fn(),
    getAttachment: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    integration.isConfigured.mockReturnValue(true);
    vi.mocked(createEmailProvider).mockResolvedValue(emailProvider as never);
    emailProvider.getMessage.mockResolvedValue({
      attachments: [
        {
          attachmentId: "att-1",
          filename: "syllabus.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    });
    emailProvider.getAttachment.mockResolvedValue({
      data: Buffer.from("pdf bytes").toString("base64"),
      size: 9,
    });
    vi.mocked(uploadComposioFile).mockResolvedValue({
      name: "syllabus.pdf",
      mimetype: "application/pdf",
      s3key: "uploads/key-1",
    });
  });

  it("uploads the attachment through the account that owns the connection", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("school-account", "googledrive"),
    ] as never);
    integration.executeTool.mockResolvedValue({
      id: "file-1",
      webViewLink: "https://drive.google.com/file/d/file-1/view?usp=drivesdk",
    });

    const result = await saveAttachmentToDrive({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      attachment: { filename: "syllabus.pdf" },
      app: "googledrive",
      logger,
    });

    // The email is read from the account being viewed, never another.
    expect(createEmailProvider).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "account-1" }),
    );
    expect(emailProvider.getAttachment).toHaveBeenCalledWith(
      "message-1",
      "att-1",
    );
    expect(vi.mocked(uploadComposioFile).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        app: "googledrive",
        tool: "GOOGLEDRIVE_UPLOAD_FILE",
        filename: "syllabus.pdf",
        content: Buffer.from("pdf bytes"),
      }),
    );
    expect(integration.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "school-account",
        tool: "GOOGLEDRIVE_UPLOAD_FILE",
        args: {
          file_to_upload: {
            name: "syllabus.pdf",
            mimetype: "application/pdf",
            s3key: "uploads/key-1",
          },
        },
      }),
    );
    expect(result).toEqual({
      filename: "syllabus.pdf",
      app: "googledrive",
      destination: "Google Drive",
      url: "https://drive.google.com/file/d/file-1/view?usp=drivesdk",
    });
  });

  it("links to the OneDrive file from a wrapped response", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("account-1", "one_drive"),
    ] as never);
    integration.executeTool.mockResolvedValue({
      data: { id: "item-1", webUrl: "https://onedrive.live.com/item-1" },
    });

    const result = await saveAttachmentToDrive({
      emailAccountId: "account-1",
      provider: "microsoft",
      messageId: "message-1",
      attachment: { attachmentId: "att-1" },
      app: "one_drive",
      logger,
    });

    expect(integration.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ user_id: "me" }),
      }),
    );
    expect(result.url).toBe("https://onedrive.live.com/item-1");
  });

  it("tells the user to reconnect a drive whose connection lapsed", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("account-1", "googledrive"),
    ] as never);
    integration.executeTool.mockRejectedValue(
      new ConnectionExpiredError("googledrive", "No active googledrive"),
    );

    const error = await saveAttachmentToDrive({
      emailAccountId: "account-1",
      provider: "google",
      messageId: "message-1",
      attachment: { filename: "syllabus.pdf" },
      app: "googledrive",
      logger,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SafeError);
    expect(error.message).toContain("Reconnect Google Drive");
  });

  it("tells the user to connect the drive, without reading the email", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([]);

    await expect(
      saveAttachmentToDrive({
        emailAccountId: "account-1",
        provider: "google",
        messageId: "message-1",
        attachment: { filename: "syllabus.pdf" },
        app: "googledrive",
        logger,
      }),
    ).rejects.toThrow("Google Drive isn't connected");
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("refuses a file Google Drive's upload can't take before downloading it", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("account-1", "googledrive"),
    ] as never);
    emailProvider.getMessage.mockResolvedValue({
      attachments: [
        {
          attachmentId: "att-big",
          filename: "lecture.mp4",
          mimeType: "video/mp4",
          size: 6 * MB,
        },
      ],
    });

    await expect(
      saveAttachmentToDrive({
        emailAccountId: "account-1",
        provider: "google",
        messageId: "message-1",
        attachment: { attachmentId: "att-big" },
        app: "googledrive",
        logger,
      }),
    ).rejects.toBeInstanceOf(SafeError);
    expect(emailProvider.getAttachment).not.toHaveBeenCalled();
  });

  it("does not save a file the email doesn't have", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("account-1", "googledrive"),
    ] as never);

    await expect(
      saveAttachmentToDrive({
        emailAccountId: "account-1",
        provider: "google",
        messageId: "message-1",
        attachment: { filename: "invented.pdf" },
        app: "googledrive",
        logger,
      }),
    ).rejects.toThrow("That attachment isn't on this email.");
    expect(uploadComposioFile).not.toHaveBeenCalled();
  });
});

function connection(emailAccountId: string, name: string) {
  return { emailAccountId, integration: { name } };
}
