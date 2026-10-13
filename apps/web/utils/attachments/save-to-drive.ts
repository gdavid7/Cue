import { DRIVE_APPS, type DriveApp } from "@/utils/attachments/drive-apps";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { findIntegration } from "@/utils/mcp/integrations";
import { uploadComposioFile } from "@/utils/mcp/providers/composio";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import {
  findConnectionAccountId,
  onePerIntegration,
  ownedBySameUser,
} from "@/utils/mcp/user-connections";
import prisma from "@/utils/prisma";

const MB = 1024 * 1024;

type StagedFile = Awaited<ReturnType<typeof uploadComposioFile>>;

const UPLOADS: Record<
  DriveApp,
  {
    tool: string;
    maxBytes?: number;
    args: (file: StagedFile) => Record<string, unknown>;
    fallbackUrl?: (id: string) => string;
  }
> = {
  googledrive: {
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    // Composio's Drive upload takes files up to 5 MB.
    maxBytes: 5 * MB,
    // No folder: Drive puts it in the root of My Drive.
    args: (file) => ({ file_to_upload: file }),
    fallbackUrl: (id) => `https://drive.google.com/file/d/${id}/view`,
  },
  one_drive: {
    tool: "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE",
    // No folder: OneDrive puts it in the root of the user's own drive, and
    // renames rather than overwrites a file of the same name.
    args: (file) => ({ file, user_id: "me" }),
  },
};

/**
 * The drives the person has connected, from any of their email accounts, that
 * Cue can save to right now.
 */
export async function getConnectedDriveApps(
  emailAccountId: string,
): Promise<{ app: DriveApp; name: string }[]> {
  const configured = DRIVE_APPS.filter(isDriveConfigured);
  if (!configured.length) return [];

  const connections = await prisma.mcpConnection.findMany({
    where: {
      isActive: true,
      integration: { name: { in: configured } },
      ...ownedBySameUser(emailAccountId),
    },
    select: { emailAccountId: true, integration: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const connected = new Set(
    onePerIntegration(connections, emailAccountId).map(
      (connection) => connection.integration.name,
    ),
  );

  return configured
    .filter((app) => connected.has(app))
    .map((app) => ({ app, name: getDriveName(app) }));
}

/**
 * Copies one attachment of the account's own email into the person's Google
 * Drive or OneDrive. The email is read through the account's own provider, so
 * a message from another account is never found.
 */
export async function saveAttachmentToDrive({
  emailAccountId,
  provider,
  messageId,
  attachment: wanted,
  app,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  messageId: string;
  attachment: { attachmentId: string } | { filename: string };
  app: DriveApp;
  logger: Logger;
}) {
  const name = getDriveName(app);
  const integration = findIntegration(app)?.provider;
  if (!integration || !isDriveConfigured(app)) {
    throw new SafeError(`Saving to ${name} isn't available.`);
  }
  // Connections are shared across the person's accounts, but the provider
  // knows each one by the account it was made from.
  const connectionAccountId = await findConnectionAccountId({
    integration: app,
    emailAccountId,
    activeOnly: true,
  });
  if (!connectionAccountId) {
    throw new SafeError(
      `${name} isn't connected. Connect it from Connectors first.`,
    );
  }

  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });
  const message = await emailProvider.getMessage(messageId);
  const attachment = message.attachments?.find((item) =>
    "attachmentId" in wanted
      ? item.attachmentId === wanted.attachmentId
      : item.filename === wanted.filename,
  );
  if (!attachment) {
    throw new SafeError("That attachment isn't on this email.");
  }

  const upload = UPLOADS[app];
  if (upload.maxBytes && attachment.size > upload.maxBytes) {
    throw new SafeError(
      `${attachment.filename} is too large to save to ${name} (the limit is ${upload.maxBytes / MB} MB).`,
    );
  }

  const { data } = await emailProvider.getAttachment(
    messageId,
    attachment.attachmentId,
  );
  const file = await uploadComposioFile({
    app: integration.app,
    tool: upload.tool,
    filename: attachment.filename,
    mimetype: attachment.mimeType || "application/octet-stream",
    content: Buffer.from(data, "base64"),
  });
  const result = await getIntegrationProvider(integration.id).executeTool({
    app: integration.app,
    authScheme: integration.authScheme,
    emailAccountId: connectionAccountId,
    tool: upload.tool,
    args: upload.args(file),
  });
  logger.info("Saved attachment to drive", { app });

  const uploaded = findUploadedFile(result);
  return {
    filename: attachment.filename,
    app,
    destination: name,
    url:
      uploaded.url ??
      (uploaded.id ? upload.fallbackUrl?.(uploaded.id) : undefined) ??
      null,
  };
}

function isDriveConfigured(app: DriveApp) {
  const provider = findIntegration(app)?.provider;
  return !!provider && getIntegrationProvider(provider.id).isConfigured();
}

function getDriveName(app: DriveApp) {
  return findIntegration(app)?.displayName ?? app;
}

// Composio passes back the app's own response, sometimes wrapped. The link is
// Drive's webViewLink or OneDrive's webUrl.
function findUploadedFile(result: unknown): { id?: string; url?: string } {
  for (const candidate of [
    result,
    field(result, "data"),
    field(result, "file"),
  ]) {
    const url =
      stringField(candidate, "webViewLink") ?? stringField(candidate, "webUrl");
    const id = stringField(candidate, "id");
    if (url || id) return { id, url };
  }
  return {};
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string) {
  const found = field(value, key);
  return typeof found === "string" && found ? found : undefined;
}
