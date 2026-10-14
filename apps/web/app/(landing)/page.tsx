import { redirect } from "next/navigation";
import { redirectToEmailAccountPath } from "@/utils/account";
import { auth } from "@/utils/auth";
import { WELCOME_PATH } from "@/utils/config";
import prisma from "@/utils/prisma";

// The root is the way into the mail app, not a marketing page. It is also the
// PWA start_url, so onboarded users go straight to their mailbox in one hop.
export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { completedOnboardingAt: true },
  });

  // First runs and orphaned sessions keep going through the welcome redirect,
  // which completes onboarding or logs the session out.
  if (!user?.completedOnboardingAt) redirect(WELCOME_PATH);

  await redirectToEmailAccountPath("/mail", undefined, session);
}
