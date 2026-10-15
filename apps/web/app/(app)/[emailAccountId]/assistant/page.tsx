import { Suspense } from "react";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { EmailLabelsProvider } from "@/providers/EmailLabelsProvider";
import { Chat } from "@/components/assistant-chat/chat";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { checkUserOwnsEmailAccount } from "@/utils/email-account";

export const maxDuration = 300; // Applies to the actions

export default async function AssistantPage({
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

        <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
          <Chat
            open
            topBarStart={
              <SidebarTrigger
                className="-ml-2 size-10 md:hidden"
                name="left-sidebar"
              />
            }
          />
        </div>
      </Suspense>
    </EmailLabelsProvider>
  );
}
