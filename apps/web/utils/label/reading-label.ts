import { SystemType } from "@/generated/prisma/enums";
import { getRuleLabel } from "@/utils/rule/consts";

/**
 * The label (an Outlook category) Cue files newsletters under, which Today's
 * and Mail's Reading lanes bundle. Undefined when the account has none.
 */
export function findReadingLabelId(
  labels: readonly { id?: string | null; name: string }[],
): string | undefined {
  const wanted = getRuleLabel(SystemType.NEWSLETTER).toLowerCase();
  return (
    labels.find((label) => label.name.trim().toLowerCase() === wanted)?.id ??
    undefined
  );
}
