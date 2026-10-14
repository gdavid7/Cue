import { Suspense } from "react";
import { MailFrame } from "@/app/(app)/[emailAccountId]/mail/MailFrame";
import { MailListPlaceholder } from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { MailShell } from "@/app/(app)/[emailAccountId]/mail/MailShell";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import {
  ConversionAnalyticsScript,
  ConversionQueryParamEvents,
} from "@/components/ConversionAnalytics";
import { EmailLabelsProvider } from "@/providers/EmailLabelsProvider";
import { MailEngineHost } from "@/utils/mail-engine/MailEngineHost";

export const maxDuration = 300;

export default function Mail() {
  return (
    <EmailLabelsProvider>
      {/* New accounts and checkout both land here, carrying conversion events. */}
      <Suspense>
        <ConversionQueryParamEvents />
      </Suspense>
      <ConversionAnalyticsScript />
      {/* The frame paints at once; only the list waits for the engine. */}
      <MailEngineHost
        fallback={
          <MailFrame activeType="inbox">
            <MailListPlaceholder message="Opening your mailbox…" withChrome />
          </MailFrame>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PermissionsCheck />
          <MailShell />
        </div>
      </MailEngineHost>
    </EmailLabelsProvider>
  );
}
