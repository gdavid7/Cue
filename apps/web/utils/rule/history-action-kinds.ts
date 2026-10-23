import { ActionType } from "@/generated/prisma/enums";

/**
 * The kinds of work Assistant > History can be filtered to, and that Today's
 * "While you were away" counts, so a count and the list it links to agree.
 * Safe for the browser; the SQL that applies them is in history-actions.ts.
 * Outlook files mail by moving it to a folder, as Gmail does with a label.
 */
export const HISTORY_ACTIONS = {
  sorted: [ActionType.LABEL, ActionType.MOVE_FOLDER],
  archived: [ActionType.ARCHIVE],
  drafted: [ActionType.DRAFT_EMAIL],
} as const satisfies Record<string, readonly ActionType[]>;

export type HistoryAction = keyof typeof HISTORY_ACTIONS;

export const HISTORY_ACTION_NAMES = Object.keys(
  HISTORY_ACTIONS,
) as HistoryAction[];

export function isHistoryAction(value: unknown): value is HistoryAction {
  return (
    typeof value === "string" &&
    HISTORY_ACTION_NAMES.includes(value as HistoryAction)
  );
}
