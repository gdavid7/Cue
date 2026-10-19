"use client";

/**
 * Heads the Trash view. Gmail empties its trash itself after 30 days, and
 * Cue's Gmail access can't delete mail for good, so there it only says so;
 * Outlook accounts get Empty Trash.
 */
export function TrashNotice({
  onEmptyTrash,
}: {
  /** Set when the account's mail can be deleted for good from Cue. */
  onEmptyTrash?: () => void;
}) {
  return (
    <p
      role="note"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-border border-b px-4 py-2 text-center text-muted-foreground text-xs"
    >
      {onEmptyTrash ? (
        <>
          <span>Emptying Trash deletes its mail for good.</span>
          <button
            type="button"
            onClick={onEmptyTrash}
            className="relative rounded font-medium text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
          >
            Empty Trash
          </button>
        </>
      ) : (
        <span>
          Gmail deletes conversations in Trash for good after 30 days.
        </span>
      )}
    </p>
  );
}
