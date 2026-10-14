"use client";

import { createContext, useContext } from "react";
import { MutedText } from "@/components/Typography";
import { Card, CardContent } from "@/components/ui/card";

const InSettingGroupContext = createContext(false);

/**
 * One card for a run of related settings, each a row divided from the next,
 * rather than a stack of separate bordered cards. Empty when none of its
 * settings render, so a heading above it can hide with it.
 */
export function SettingCardGroup({ children }: { children: React.ReactNode }) {
  return (
    <InSettingGroupContext.Provider value={true}>
      <Card className="divide-y overflow-hidden" data-setting-group>
        {children}
      </Card>
    </InSettingGroupContext.Provider>
  );
}

export function SettingCard({
  title,
  description,
  right,
  collapseOnMobile = false,
}: {
  title: React.ReactNode;
  description: string;
  right: React.ReactNode;
  collapseOnMobile?: boolean;
}) {
  const inGroup = useContext(InSettingGroupContext);
  const row = (
    <div
      className={
        collapseOnMobile
          ? "flex flex-col gap-4 md:flex-row md:items-center"
          : "flex items-center gap-4"
      }
    >
      <div className="flex-1">
        <h3 className="font-medium">{title}</h3>
        <MutedText>{description}</MutedText>
      </div>

      {right}
    </div>
  );

  if (inGroup)
    return (
      <div className="p-4" data-setting-card>
        {row}
      </div>
    );

  return (
    <Card data-setting-card>
      <CardContent className="p-4">{row}</CardContent>
    </Card>
  );
}
