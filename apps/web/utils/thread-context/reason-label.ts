import type { ContextReason } from "@cue/context";

/** Why an item is related, in a few words: "With Nora Patel", "In 2d". */
export function reasonLabel(reason: ContextReason) {
  switch (reason.type) {
    case "person":
      return `With ${reason.label}`;
    case "organization":
      return `Also from ${reason.label}`;
    case "via":
      return `Via ${reason.label}`;
    case "linked":
      return "Linked in this email";
    case "topic":
      // Two shared words read as a reason; a run of them reads as a dump.
      return `Also mentions ${reason.terms
        .slice(0, 2)
        .map((term) => `“${term}”`)
        .join(" and ")}`;
    case "upcoming":
      return reason.days === 0 ? "Today" : `In ${reason.days}d`;
    case "due":
      return reason.days === 0 ? "Due today" : `Due in ${reason.days}d`;
  }
}
