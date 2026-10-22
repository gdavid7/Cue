import { auth } from "@/utils/auth";
import { isAdmin } from "@/utils/admin";
import prisma from "@/utils/prisma";
import { ErrorPage } from "@/components/ErrorPage";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { FeedbackList } from "@/app/(app)/admin/feedback/FeedbackList";

export default async function AdminFeedbackPage() {
  const session = await auth(undefined, { disableCookieCache: true });

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  const feedback = await prisma.feedback.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: {
      id: true,
      createdAt: true,
      message: true,
      page: true,
      status: true,
      user: { select: { email: true } },
      emailAccount: { select: { email: true } },
    },
  });

  return (
    <PageWrapper>
      <PageHeader
        title="Feedback"
        description="What beta testers sent from the app, newest first."
      />
      <FeedbackList feedback={feedback} />
    </PageWrapper>
  );
}
