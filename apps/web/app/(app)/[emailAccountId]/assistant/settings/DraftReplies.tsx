"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { Toggle } from "@/components/Toggle";
import { enableDraftRepliesAction } from "@/utils/actions/rule";
import { toastError } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useRules } from "@/hooks/useRules";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { LoadingContent } from "@/components/LoadingContent";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingCard } from "@/components/SettingCard";
import { getDraftRepliesSetting } from "@/utils/rule/draft-replies-enabled";
import { getActionErrorMessage } from "@/utils/error";

export function DraftReplies() {
  const { enabled, toggleDraftReplies, loading, error } = useDraftReplies();

  const handleToggle = useCallback(
    async (enable: boolean) => {
      try {
        await toggleDraftReplies(enable);
      } catch (error) {
        toastError({
          description: `There was an error: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    },
    [toggleDraftReplies],
  );

  return (
    <SettingCard
      title="Auto draft replies"
      description="Cue suggests a reply in your tone for mail that needs one, ready when you open the email. Suggestions stay in Cue until you edit them, and Cue never sends anything itself. Turn this off and Cue leaves every reply to you."
      right={
        <LoadingContent
          loading={loading}
          error={error}
          loadingComponent={<Skeleton className="h-8 w-32" />}
        >
          <Toggle
            name="draft-replies"
            enabled={enabled}
            onChange={handleToggle}
          />
        </LoadingContent>
      }
    />
  );
}

export function useDraftReplies() {
  const { data, mutate, isLoading, error } = useRules();
  const { emailAccountId } = useAccount();
  const { mutate: mutateGlobal } = useSWRConfig();

  const toReplyRule = data?.find(
    (rule) => rule.systemType === SystemType.TO_REPLY,
  );

  const toggleDraftReplies = useCallback(
    async (enable: boolean) => {
      if (!data) return;

      const optimisticData = data.map((rule) => {
        if (rule.systemType === SystemType.TO_REPLY) {
          return {
            ...rule,
            // The action turns the whole To Reply rule on or off with drafting.
            enabled: enable,
            actions: enable
              ? rule.actions.some(
                  (action) => action.type === ActionType.DRAFT_EMAIL,
                )
                ? rule.actions
                : [
                    ...rule.actions,
                    {
                      id: `temp-${Date.now()}`, // Temporary ID for optimistic update
                      type: ActionType.DRAFT_EMAIL,
                      ruleId: rule.id,
                      emailAccountId,
                      label: null,
                      labelId: null,
                      subject: null,
                      content: null,
                      to: null,
                      cc: null,
                      bcc: null,
                      url: null,
                      delayInMinutes: null,
                      folderName: null,
                      folderId: null,
                      messagingChannelId: null,
                      messagingChannelEmailAccountId: null,
                      messagingChannel: null,
                      staticAttachments: null,
                      integrationName: null,
                      integrationToolName: null,
                      integrationArgs: null,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                  ]
              : // Remove DRAFT_EMAIL action if disabling
                rule.actions.filter(
                  (action) => action.type !== ActionType.DRAFT_EMAIL,
                ),
          };
        }
        return rule;
      });

      // Update SWR cache optimistically
      mutate(optimisticData, false);

      let result: Awaited<ReturnType<typeof enableDraftRepliesAction>>;
      try {
        result = await enableDraftRepliesAction(emailAccountId, { enable });
      } finally {
        // Settles the optimistic update either way. To Reply is also reply
        // tracking, so Mail's "Reply tracking is off" notice follows it.
        mutate();
        mutateGlobal("/api/mail/settings");
      }
      if (result?.serverError || result?.validationErrors) {
        throw new Error(getActionErrorMessage(result));
      }
      return result;
    },
    [data, mutate, mutateGlobal, emailAccountId],
  );

  const setting = getDraftRepliesSetting(toReplyRule);
  return {
    enabled: setting === "on",
    setting,
    toggleDraftReplies,
    loading: isLoading,
    error,
  };
}
