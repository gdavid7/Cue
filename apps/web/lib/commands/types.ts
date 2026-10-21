import type { LucideIcon } from "lucide-react";

export type CommandSection =
  | "actions"
  | "navigation"
  | "rules"
  | "accounts"
  | "settings";

export interface Command {
  /**
   * The account it acts in or opens, named while the user looks at all
   * their accounts together.
   */
  account?: string;
  action: () => void | Promise<void>;
  closeOnSelect?: boolean;
  description?: string;
  disabled?: boolean;
  icon?: LucideIcon;
  id: string;
  keywords?: string[];
  label: string;
  priority?: number;
  section: CommandSection;
  shortcut?: string;
}
