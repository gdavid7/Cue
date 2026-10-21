import { Suspense } from "react";
import { InboxPreviewList } from "@/app/(app)/[emailAccountId]/mail/InboxPreviewList";
import { MailShell } from "@/app/(app)/[emailAccountId]/mail/MailShell";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import {
  ConversionAnalyticsScript,
  ConversionQueryParamEvents,
} from "@/components/ConversionAnalytics";
import { EmailLabelsProvider } from "@/providers/EmailLabelsProvider";
import { MailEngineHost } from "@/utils/mail-engine/MailEngineHost";

export function MailScreen() {
  return (
    <EmailLabelsProvider>
      {/* New accounts and checkout both land here, carrying conversion events. */}
      <Suspense>
        <ConversionQueryParamEvents />
      </Suspense>
      <ConversionAnalyticsScript />
      {/* The route layout's frame paints at once; the inbox shows its newest
          mail from the server while the engine opens. The mail screen itself
          takes over once the page hydrates, before the engine is ready, so
          nothing opened on it is lost when the engine arrives. */}
      <MailEngineHost
        showChildrenWhileStarting
        fallback={
          <InboxPreviewList message="Opening your mailbox…" withChrome />
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <PermissionsCheck />
          <MailShell />
        </div>
      </MailEngineHost>
    </EmailLabelsProvider>
  );
}
