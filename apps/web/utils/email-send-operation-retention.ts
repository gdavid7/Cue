import { EmailSendOperationStatus } from "@/generated/prisma/enums";
import { MAIL_MUTATION_RETRY_WINDOW_MS } from "@/utils/email/send-operation-policy";
import prisma from "@/utils/prisma";

export async function deleteExpiredEmailSendOperations(
  now = new Date(),
): Promise<number> {
  const expiredWhere = expiredSendOperationWhere(now);
  // An undo hold only matters while its send can still be retried, or while
  // the reminder it carries is still to run.
  await prisma.scheduledEmail.deleteMany({
    where: {
      heldForUndo: true,
      status: { in: ["SENT", "CANCELLED", "FAILED", "UNCERTAIN"] },
      reminderStatus: { notIn: ["PENDING", "PROCESSING"] },
      updatedAt: expiredWhere.updatedAt,
    },
  });
  const result = await prisma.emailSendOperation.deleteMany({
    where: expiredWhere,
  });
  return result.count;
}

function expiredSendOperationWhere(now: Date) {
  return {
    status: {
      in: [EmailSendOperationStatus.SENT, EmailSendOperationStatus.UNCERTAIN],
    },
    updatedAt: {
      lt: new Date(now.getTime() - MAIL_MUTATION_RETRY_WINDOW_MS),
    },
  };
}
