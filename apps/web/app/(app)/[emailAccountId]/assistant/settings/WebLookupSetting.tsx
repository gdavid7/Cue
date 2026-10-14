"use client";

import { useCallback } from "react";
import { useAction } from "next-safe-action/hooks";
import { LoadingContent } from "@/components/LoadingContent";
import { SettingCard } from "@/components/SettingCard";
import { Toggle } from "@/components/Toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useAccount } from "@/providers/EmailAccountProvider";
import { enableWebLookupAction } from "@/utils/actions/rule";
import { createSettingActionErrorHandler } from "@/utils/actions/error-handling";

export function WebLookupSetting() {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useEmailAccountFull();

  const { execute } = useAction(
    enableWebLookupAction.bind(null, emailAccountId),
    {
      onSuccess: () => {
        mutate();
      },
      onError: createSettingActionErrorHandler({
        mutate,
        prefix: "Failed to update web lookup setting",
      }),
    },
  );

  const handleToggle = useCallback(
    (enable: boolean) => {
      if (!data) return;
      mutate({ ...data, webLookupEnabled: enable }, false);
      execute({ enable });
    },
    [data, execute, mutate],
  );

  if (data && !data.webLookupAvailable) return null;

  return (
    <SettingCard
      title="Web lookup for suggested replies"
      description="When your mail and calendar can't back a reply, Cue searches public web pages for what's missing. Only a short query of public names and topics is sent, not your email."
      right={
        <LoadingContent
          loading={isLoading}
          error={error}
          loadingComponent={<Skeleton className="h-8 w-32" />}
        >
          <Toggle
            name="web-lookup"
            enabled={data?.webLookupEnabled ?? true}
            onChange={handleToggle}
            disabled={isLoading}
          />
        </LoadingContent>
      }
    />
  );
}
