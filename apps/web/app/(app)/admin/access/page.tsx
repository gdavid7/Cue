import { env } from "@/env";
import { auth } from "@/utils/auth";
import { isAdmin } from "@/utils/admin";
import prisma from "@/utils/prisma";
import { ErrorPage } from "@/components/ErrorPage";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { AccessRequests } from "@/app/(app)/admin/access/AccessRequests";
import { InfoIcon } from "lucide-react";
import { AlertBasic } from "@/components/Alert";
import {
  GOOGLE_OAUTH_TEST_USERS_URL,
  GOOGLE_OAUTH_TESTING_MODE,
} from "@/utils/access/config";

export default async function AdminAccessPage() {
  const session = await auth();

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  const requests = await prisma.accessRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: {
      id: true,
      email: true,
      name: true,
      source: true,
      status: true,
      createdAt: true,
      decidedAt: true,
      notifiedAt: true,
    },
  });

  return (
    <PageWrapper>
      <PageHeader
        title="Access requests"
        description={
          env.AUTH_WAITLIST_ENABLED
            ? "Only approved people can create an account."
            : "The waitlist is off, so anyone can still sign up. Set AUTH_WAITLIST_ENABLED=true to require approval."
        }
      />
      {env.AUTH_WAITLIST_ENABLED &&
        (env.AUTH_ALLOWED_EMAIL_DOMAINS?.length ?? 0) > 0 && (
          <AlertBasic
            className="mt-6"
            variant="blue"
            icon={<InfoIcon className="size-4" aria-hidden />}
            title="AUTH_ALLOWED_EMAIL_DOMAINS is ignored while the waitlist is on"
            description="A domain would let in everyone at it without review. Approve people from those domains here, one at a time. People who already have an account keep it."
          />
        )}
      {GOOGLE_OAUTH_TESTING_MODE && (
        <AlertBasic
          className="mt-6"
          variant="blue"
          icon={<InfoIcon className="size-4" aria-hidden />}
          title="Also add each approved address as a Google test user"
          description={
            <>
              Cue&apos;s Google app is in Testing, so Google only lets listed
              test users sign in. After approving someone here, add that exact
              address under Audience → Test users in{" "}
              <a
                href={GOOGLE_OAUTH_TEST_USERS_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-4"
              >
                Google Cloud Console
              </a>
              .
            </>
          }
        />
      )}
      <AccessRequests
        requests={requests}
        senderName={session?.user.name ?? null}
        baseUrl={env.NEXT_PUBLIC_BASE_URL}
        allowlistCount={env.AUTH_ALLOWED_EMAILS?.length ?? 0}
      />
    </PageWrapper>
  );
}
