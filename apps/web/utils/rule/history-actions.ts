import { Prisma } from "@/generated/prisma/client";
import {
  HISTORY_ACTIONS,
  type HistoryAction,
} from "@/utils/rule/history-action-kinds";

/**
 * The SQL condition for an ExecutedAction row (as `alias`) that did one of
 * these kinds of work. History's filter and Today's counts both use it, so a
 * count matches the list it links to: an action that failed or was skipped
 * didn't happen.
 */
export function historyActionCondition(
  alias: string,
  actions: readonly HistoryAction[],
) {
  const table = Prisma.raw(`"${alias}"`);
  const types = actions
    .flatMap((action) => HISTORY_ACTIONS[action])
    .map((type) => Prisma.sql`${type}::"ActionType"`);
  return Prisma.sql`${table}.type IN (${Prisma.join(types)})
    AND (${table}."executionStatus" IS NULL OR ${table}."executionStatus" = 'SUCCEEDED')`;
}
