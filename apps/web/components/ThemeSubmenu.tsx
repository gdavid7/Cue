"use client";

import { useTheme } from "next-themes";
import { SunMoonIcon } from "lucide-react";
import {
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_OPTIONS } from "@/components/theme-options";

/** Appearance choices inside an account menu, next to Settings. */
export function ThemeSubmenu({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={className}>
        <SunMoonIcon className="size-4 text-muted-foreground" />
        Appearance
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="min-w-36">
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                className="gap-2"
              >
                <Icon className="size-4 text-muted-foreground" />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
