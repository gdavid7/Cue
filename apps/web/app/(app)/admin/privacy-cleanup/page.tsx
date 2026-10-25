import { env } from "@/env";
import { auth } from "@/utils/auth";
import { isAdmin } from "@/utils/admin";
import { ErrorPage } from "@/components/ErrorPage";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { PrivacyCleanup } from "@/app/(app)/admin/privacy-cleanup/PrivacyCleanup";

// Each action call scans for up to 45s; it runs under this page's limit.
export const maxDuration = 300;

export default async function AdminPrivacyCleanupPage() {
  const session = await auth(undefined, { disableCookieCache: true });

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  return (
    <PageWrapper>
      <PageHeader
        title="Privacy cleanup"
        description="Remove email content and personal data that Redis still holds from before Cue stopped caching it."
      />
      <PrivacyCleanup chatSdkRedis={compareRedisHosts()} />
    </PageWrapper>
  );
}

function compareRedisHosts() {
  try {
    if (!env.REDIS_HTTP_URL || !env.REDIS_URL) return "unknown";
    const http = new URL(env.REDIS_HTTP_URL).hostname.toLowerCase();
    const tcp = new URL(env.REDIS_URL).hostname.toLowerCase();
    return http === tcp ? "same" : "different";
  } catch {
    return "unknown";
  }
}
