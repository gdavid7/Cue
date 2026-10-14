import { Rules } from "@/app/(app)/[emailAccountId]/assistant/Rules";
import { AddRuleDialog } from "@/app/(app)/[emailAccountId]/assistant/AddRuleDialog";
import { MutedText } from "@/components/Typography";
import { BulkRunRules } from "@/app/(app)/[emailAccountId]/assistant/BulkRunRules";

export function RulesTab() {
  return (
    <div>
      <div className="flex items-center mb-2 justify-between gap-2">
        <MutedText className="hidden sm:block">
          Cue checks each new email against these rules. Some sort mail into
          Cue's tabs; others act on it, like labeling or archiving.
        </MutedText>

        <div className="flex shrink-0 items-center gap-2">
          <BulkRunRules />
          <AddRuleDialog />
        </div>
      </div>
      <Rules showAddRuleButton={false} />
    </div>
  );
}
