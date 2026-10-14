import { Suspense } from "react";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { EmailLabelsProvider } from "@/providers/EmailLabelsProvider";
import { checkUserOwnsEmailAccount } from "@/utils/email-account";
import { AIChatButton } from "@/app/(app)/[emailAccountId]/assistant/AIChatButton";
import { AllRulesDisabledBanner } from "@/app/(app)/[emailAccountId]/assistant/AllRulesDisabledBanner";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { AutomationTabs } from "@/app/(app)/[emailAccountId]/automation/AutomationTabs";

export const maxDuration = 300; // Applies to the actions

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ emailAccountId: string }>;
}) {
  const { emailAccountId } = await params;
  await checkUserOwnsEmailAccount({ emailAccountId });

  return (
    <EmailLabelsProvider>
      <Suspense>
        <PermissionsCheck />

        <PageWrapper>
          <div className="flex items-center justify-between">
            <div>
              <PageHeader
                title="Rules"
                video={{
                  title: "Getting started with Rules",
                  description:
                    "Learn how to set up rules so Cue labels, archives and drafts for you.",
                  muxPlaybackId:
                    "TYo3SIMdhg008x022H79400CxeRSiB6mLyuwHx8Szc00Rec",
                }}
              />
            </div>

            <div className="ml-4">
              <AIChatButton />
            </div>
          </div>

          <AllRulesDisabledBanner />

          <AutomationTabs />
        </PageWrapper>
      </Suspense>
    </EmailLabelsProvider>
  );
}
