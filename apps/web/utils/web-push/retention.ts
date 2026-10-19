import prisma from "@/utils/prisma";

// Delivery claims only need to outlive webhook retries for the same message.
const WEB_PUSH_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function deleteExpiredWebPushDeliveries(
  now = new Date(),
): Promise<number> {
  const result = await prisma.webPushDelivery.deleteMany({
    where: {
      createdAt: {
        lt: new Date(now.getTime() - WEB_PUSH_DELIVERY_RETENTION_MS),
      },
    },
  });
  return result.count;
}
