"use client";

import { useTheme } from "next-themes";
import { SunMoonIcon } from "lucide-react";
import {
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { DARK_EMAIL_OPTIONS, THEME_OPTIONS } from "@/components/theme-options";
import { useDarkEmailDefault } from "@/hooks/useDarkEmailMode";
import { parseDarkEmailMode } from "@/utils/email/dark-email-preference";

/** Appearance choices inside an account menu, next to Settings. */
export function ThemeSubmenu({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [darkEmailMode, setDarkEmailMode] = useDarkEmailDefault();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={className}>
        <SunMoonIcon className="size-4 text-muted-foreground" />
        Appearance
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="min-w-44">
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
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-medium text-muted-foreground text-xs">
            Emails in dark mode
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={darkEmailMode}
            onValueChange={(value) =>
              setDarkEmailMode(parseDarkEmailMode(value))
            }
          >
            {DARK_EMAIL_OPTIONS.map(({ value, label, icon: Icon }) => (
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
