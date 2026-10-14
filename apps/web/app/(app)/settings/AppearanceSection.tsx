"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { DARK_EMAIL_OPTIONS, THEME_OPTIONS } from "@/components/theme-options";
import { useDarkEmailDefault } from "@/hooks/useDarkEmailMode";
import { parseDarkEmailMode } from "@/utils/email/dark-email-preference";

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [darkEmailMode, setDarkEmailMode] = useDarkEmailDefault();

  // next-themes only knows the stored theme on the client.
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Theme</ItemTitle>
        </ItemContent>
        <ItemActions>
          <Select
            value={mounted ? (theme ?? "system") : undefined}
            onValueChange={setTheme}
            disabled={!mounted}
          >
            <SelectTrigger aria-label="Theme" className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Emails in dark mode</ItemTitle>
          <ItemDescription>
            Recolor designed emails to match, or show them as sent.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={mounted ? darkEmailMode : undefined}
            onValueChange={(value) =>
              setDarkEmailMode(parseDarkEmailMode(value))
            }
            disabled={!mounted}
          >
            <SelectTrigger
              aria-label="Emails in dark mode"
              className="h-9 w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DARK_EMAIL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
    </>
  );
}
