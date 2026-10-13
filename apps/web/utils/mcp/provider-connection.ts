import prisma from "@/utils/prisma";

/**
 * Records that the account has a provider-hosted connection to the app. The
 * provider holds the credentials; we keep only the link and its tools.
 */
export async function saveProviderConnection({
  integration,
  emailAccountId,
}: {
  integration: string;
  emailAccountId: string;
}) {
  const dbIntegration = await prisma.mcpIntegration.upsert({
    where: { name: integration },
    update: {},
    create: { name: integration },
    select: { id: true },
  });

  await prisma.mcpConnection.upsert({
    where: {
      emailAccountId_integrationId: {
        emailAccountId,
        integrationId: dbIntegration.id,
      },
    },
    update: { isActive: true },
    create: {
      name: integration,
      emailAccountId,
      integrationId: dbIntegration.id,
      isActive: true,
    },
  });
}
