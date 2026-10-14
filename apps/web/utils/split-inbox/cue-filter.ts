import { z } from "zod";
import { SystemType } from "@/generated/prisma/enums";

/**
 * What Cue sorts into its own tabs. Membership lives in Cue's database, so
 * these tabs work without Cue labelling anything in the user's mailbox.
 */
export const CUE_FILTER_VALUES = [
  SystemType.TO_REPLY,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
] as const;

export const cueFilterValueSchema = z.enum(CUE_FILTER_VALUES);
export type CueFilterValue = z.infer<typeof cueFilterValueSchema>;

/**
 * Provider message ids per sorted value. A conversation belongs to a value when
 * any of its messages is listed.
 */
export type CueMembership = Record<CueFilterValue, string[]>;

export const CUE_FILTER_NAMES: Record<CueFilterValue, string> = {
  TO_REPLY: "Needs reply",
  NEWSLETTER: "Newsletter",
  MARKETING: "Marketing",
};

export function splitUsesCue(split: { filters: { kind: string }[] }) {
  return split.filters.some((filter) => filter.kind === "CUE");
}

export function isCueFilterValue(
  value: string | null | undefined,
): value is CueFilterValue {
  return cueFilterValueSchema.safeParse(value).success;
}
