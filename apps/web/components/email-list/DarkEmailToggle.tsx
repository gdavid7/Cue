"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { Button } from "@/components/ui/button";
import { useDarkEmailMode } from "@/hooks/useDarkEmailMode";

/**
 * Switches a designed email between its dark adaptation and the colors it was
 * sent with. The choice sticks to the sender, so their next email opens the
 * same way.
 */
export function DarkEmailToggle({
  emailAccountId,
  sender,
}: {
  emailAccountId: string;
  sender: string;
}) {
  const { mode, setMode } = useDarkEmailMode(emailAccountId, sender);
  const adapted = mode === "adapt";
  const label = adapted ? "Show original" : "Adapt to dark mode";

  return (
    <Tooltip content={label}>
      <Button
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setMode(adapted ? "original" : "adapt");
        }}
        size="iconXs"
        variant="ghostMuted"
      >
        {adapted ? (
          <SunIcon className="size-3.5" />
        ) : (
          <MoonIcon className="size-3.5" />
        )}
      </Button>
    </Tooltip>
  );
}
