"use client";

import { Switch } from "@/components/ui/switch";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { usePreSendCheck } from "@/hooks/usePreSendCheck";

export function PreSendCheckSetting() {
  const [enabled, setEnabled] = usePreSendCheck();

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Check before sending</ItemTitle>
          <ItemDescription>
            Pause a send to point out a missing attachment or subject, a large
            reply-all or someone new on a reply.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label="Check before sending"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </ItemActions>
      </Item>
    </>
  );
}
