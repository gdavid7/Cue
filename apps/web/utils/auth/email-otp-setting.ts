import { isTransactionalEmailConfigured } from "@inboxzero/transactional-email/src/delivery";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";

export async function updateEmailOtpSetting({
  userId,
  sessionId,
  enabled,
}: {
  userId: string;
  sessionId: string | undefined;
  enabled: boolean;
}) {
  const session = sessionId
    ? await prisma.session.findFirst({
        where: { id: sessionId, userId, expires: { gt: new Date() } },
        select: { emailOtp: true },
      })
    : null;
  if (!session || session.emailOtp) {
    throw new SafeError(
      "Sign in with your connected provider to change email code access.",
    );
  }
  if (enabled && !isTransactionalEmailConfigured()) {
    throw new SafeError(
      "Email delivery is not configured. Contact your administrator.",
    );
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  // Sign-in refuses codes for these accounts (see utils/auth/email-otp.ts).
  if (enabled && !user.emailVerified) {
    throw new SafeError(
      "Email codes need an email address that your sign-in provider has verified.",
    );
  }
  // Version changes also invalidate sessions inserted after the revocation delete.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        emailOtpEnabled: enabled,
        emailOtpVersion: { increment: 1 },
        ...(enabled ? { email: user.email.trim().toLowerCase() } : {}),
      },
    }),
    // Clear pending codes on either transition so re-enabling cannot revive one.
    prisma.verificationToken.deleteMany({
      where: { identifier: `sign-in-otp-${user.email.trim().toLowerCase()}` },
    }),
    ...(!enabled
      ? [prisma.session.deleteMany({ where: { userId, emailOtp: true } })]
      : []),
  ]);
  return { enabled };
}
