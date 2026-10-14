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
  ItemTitle,
} from "@/components/ui/item";
import { THEME_OPTIONS } from "@/components/theme-options";

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes only knows the stored theme on the client.
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
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
  );
}
