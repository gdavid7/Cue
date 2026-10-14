import { AboutSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/AboutSetting";
import { SensitiveDataPolicySetting } from "@/app/(app)/[emailAccountId]/assistant/settings/SensitiveDataPolicySetting";
import { DigestSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/DigestSetting";
import { DraftConfidenceSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftConfidenceSetting";
import { DraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";
import { DraftKnowledgeSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftKnowledgeSetting";
import { FollowUpRemindersSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/FollowUpRemindersSetting";
import { HiddenAiDraftLinksSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/HiddenAiDraftLinksSetting";
import { LearnedPatternsSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/LearnedPatternsSetting";
import { PersonalSignatureSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/PersonalSignatureSetting";
import { SentWithSignatureSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/SentWithSignatureSetting";
import { SnippetsSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/SnippetsSetting";
import { MultiRuleSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/MultiRuleSetting";
import { SyncToExtensionSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/SyncToExtensionSetting";
import { WritingStyleSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/WritingStyleSetting";
import { WebLookupSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/WebLookupSetting";
import { SettingCardGroup } from "@/components/SettingCard";
import { SectionHeader } from "@/components/Typography";
import { env } from "@/env";

const autoDraftDisabled = env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED;

// A group whose settings all render nothing hides, heading included.
const GROUP_CLASS = "space-y-2 [&:has([data-setting-group]:empty)]:hidden";

export function SettingsTab() {
  return (
    <div className="max-w-4xl space-y-6">
      {!autoDraftDisabled && (
        <div className={GROUP_CLASS}>
          <SettingCardGroup>
            <DraftReplies />
            <DraftConfidenceSetting />
          </SettingCardGroup>
        </div>
      )}

      <div className={GROUP_CLASS}>
        <SectionHeader>Updates</SectionHeader>
        <SettingCardGroup>
          <FollowUpRemindersSetting />
          {env.NEXT_PUBLIC_DIGEST_ENABLED && <DigestSetting />}
        </SettingCardGroup>
      </div>

      <div className={GROUP_CLASS}>
        <SectionHeader>Your voice</SectionHeader>
        <SettingCardGroup>
          <WritingStyleSetting />
          <AboutSetting />
          <PersonalSignatureSetting />
          <SnippetsSetting />
          <SentWithSignatureSetting />
        </SettingCardGroup>
      </div>

      {!autoDraftDisabled && (
        <div className={GROUP_CLASS}>
          <SectionHeader>Knowledge</SectionHeader>
          <SettingCardGroup>
            <DraftKnowledgeSetting />
            <LearnedPatternsSetting />
          </SettingCardGroup>
        </div>
      )}

      <div className={GROUP_CLASS}>
        <SectionHeader>Advanced</SectionHeader>
        <SettingCardGroup>
          <SyncToExtensionSetting />
          <MultiRuleSetting />
          <HiddenAiDraftLinksSetting />
          {!env.NEXT_PUBLIC_SENSITIVE_DATA_POLICY_LOCKED && (
            <SensitiveDataPolicySetting />
          )}
          <WebLookupSetting />
        </SettingCardGroup>
      </div>
    </div>
  );
}
