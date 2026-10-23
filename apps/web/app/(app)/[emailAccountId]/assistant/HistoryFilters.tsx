"use client";

import {
  parseAsInteger,
  parseAsIsoDateTime,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from "nuqs";
import { ChevronDown, ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HistoryFilters } from "@/hooks/useExecutedRules";
import {
  HISTORY_ACTION_NAMES,
  type HistoryAction,
} from "@/utils/rule/history-action-kinds";

const HISTORY_ACTION_LABELS: Record<HistoryAction, string> = {
  sorted: "Sorted",
  archived: "Archived",
  drafted: "Drafted replies",
};

const filterParsers = {
  action: parseAsStringLiteral(HISTORY_ACTION_NAMES),
  since: parseAsIsoDateTime,
  until: parseAsIsoDateTime,
  automated: parseAsString,
  page: parseAsInteger,
  ruleId: parseAsString.withDefault("all"),
};

/**
 * History's filters beyond the rule, from the URL. Emails that matched no
 * rule had nothing done to them, so the action filter doesn't apply there.
 */
export function useHistoryFilters(): HistoryFilters {
  const [{ action, since, until, automated, ruleId }] =
    useQueryStates(filterParsers);
  return {
    action: ruleId === "skipped" ? null : action,
    since: since?.toISOString() ?? null,
    until: until?.toISOString() ?? null,
    automatedOnly: automated === "1",
  };
}

/** Narrows History to one kind of work, as Today's "While you were away" counts it. */
export function HistoryActionSelect() {
  const [{ action, ruleId }, setQuery] = useQueryStates(filterParsers);
  const noMatch = ruleId === "skipped";
  // A new filter starts from its first page.
  const select = (value: HistoryAction | null) =>
    setQuery({ action: value, page: null });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-10 whitespace-nowrap"
          disabled={noMatch}
        >
          <ListFilter className="mr-2 h-4 w-4" />
          {action && !noMatch ? HISTORY_ACTION_LABELS[action] : "All actions"}
          <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => select(null)}>
          All actions
        </DropdownMenuItem>
        {HISTORY_ACTION_NAMES.map((name) => (
          <DropdownMenuItem key={name} onClick={() => select(name)}>
            {HISTORY_ACTION_LABELS[name]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Says the list is the window Today's "While you were away" counted, with a
 * way back to the whole history.
 */
export function HistoryWindowNotice() {
  const [{ since, until }, setQuery] = useQueryStates(filterParsers);
  if (!since && !until) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
      Showing what Cue did while you were away.
      <Button
        className="h-auto p-0"
        onClick={() =>
          setQuery({ since: null, until: null, automated: null, page: null })
        }
        size="sm"
        variant="link"
      >
        Show all history
      </Button>
    </p>
  );
}
