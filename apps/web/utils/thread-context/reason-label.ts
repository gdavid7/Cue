import type { ContextReason } from "@cue/context";

/** Why an item is related, in a few words: "With Nora Patel", "In 2d". */
export function reasonLabel(reason: ContextReason) {
  switch (reason.type) {
    case "person":
      return `With ${reason.label}`;
    case "organization":
      return `Same org · ${reason.label}`;
    case "via":
      return `Via ${reason.label}`;
    case "topic":
      return `About ${reason.terms.join(", ")}`;
    case "upcoming":
      return reason.days === 0 ? "Today" : `In ${reason.days}d`;
  }
}
