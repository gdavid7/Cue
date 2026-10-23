import { useRules } from "@/hooks/useRules";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingContent } from "@/components/LoadingContent";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { ChevronDown, ListFilter, Tag } from "lucide-react";
import {
  HISTORY_ACTION_NAMES,
  type HistoryAction,
} from "@/utils/rule/history-actions";

export function RulesSelect() {
  const { data, isLoading, error } = useRules();
  const [ruleId, setRuleId] = useQueryState(
    "ruleId",
    parseAsString.withDefault("all"),
  );
  const getCurrentLabel = () => {
    if (ruleId === "all") return "All rules";
    if (ruleId === "skipped") return "No match";
    const rule = data?.find((rule) => rule.id === ruleId);
    if (!rule) return "All rules";
    return rule.enabled ? rule.name : `${rule.name} (disabled)`;
  };

  return (
    <LoadingContent
      loading={isLoading}
      error={error}
      loadingComponent={<Skeleton className="h-10 w-[200px]" />}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-10 whitespace-nowrap"
          >
            <Tag className="mr-2 h-4 w-4" />
            {getCurrentLabel()}
            <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setRuleId("all")}>
            All rules
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRuleId("skipped")}>
            No match
          </DropdownMenuItem>
          {data?.map((rule) => (
            <DropdownMenuItem key={rule.id} onClick={() => setRuleId(rule.id)}>
              {rule.name}
              {!rule.enabled && (
                <span className="ml-1 text-muted-foreground">(disabled)</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </LoadingContent>
  );
}

const HISTORY_ACTION_LABELS: Record<HistoryAction, string> = {
  sorted: "Sorted",
  archived: "Archived",
  drafted: "Drafted replies",
};

/** Narrows History to one kind of work, as Today's "While you were away" counts it. */
export function HistoryActionSelect() {
  const [action, setAction] = useQueryState(
    "action",
    parseAsStringLiteral(HISTORY_ACTION_NAMES),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-10 whitespace-nowrap">
          <ListFilter className="mr-2 h-4 w-4" />
          {action ? HISTORY_ACTION_LABELS[action] : "All actions"}
          <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setAction(null)}>
          All actions
        </DropdownMenuItem>
        {HISTORY_ACTION_NAMES.map((name) => (
          <DropdownMenuItem key={name} onClick={() => setAction(name)}>
            {HISTORY_ACTION_LABELS[name]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
