"use client";

import { SettingsIcon } from "lucide-react";
import { ActionCard } from "@/components/ui/card";
import { useRules } from "@/hooks/useRules";

export function AllRulesDisabledBanner() {
  const { data: rules, isLoading } = useRules();

  if (isLoading || !rules) return null;

  const allRulesDisabled = rules.every((rule) => !rule.enabled);

  if (!allRulesDisabled) return null;

  return (
    <ActionCard
      className="max-w-full mt-4"
      variant="blue"
      icon={<SettingsIcon className="h-5 w-5" />}
      title="All rules are disabled"
      description="Cue isn't sorting your mail because every rule is off. Turn on the rules you want below."
    />
  );
}
