import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { registerUtmTracking } from "@/app/(landing)/welcome/utms";
import { auth } from "@/utils/auth";
import prisma from "@/utils/prisma";
import { redirectToEmailAccountPath } from "@/utils/account";

export default async function WelcomeRedirectPage() {
  const session = await auth();

  if (!session?.user) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { completedOnboardingAt: true },
  });

  // Session exists but user doesn't - invalid state, log out
  if (!user) redirect("/logout");

  // Cue's first run happens in the inbox itself, so arriving there is what
  // completes onboarding.
  if (!user.completedOnboardingAt) {
    registerUtmTracking({
      authPromise: Promise.resolve(session),
      cookieStore: await cookies(),
    });
    await prisma.user.updateMany({
      where: { id: session.user.id, completedOnboardingAt: null },
      data: { completedOnboardingAt: new Date() },
    });
  }

  await redirectToEmailAccountPath("/mail", undefined, session);
}
