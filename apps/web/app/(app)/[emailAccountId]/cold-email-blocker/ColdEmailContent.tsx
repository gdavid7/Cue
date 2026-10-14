"use client";

import Link from "next/link";
import { useQueryState } from "nuqs";
import { ColdEmailList } from "@/app/(app)/[emailAccountId]/cold-email-blocker/ColdEmailList";
import { ColdEmailRejected } from "@/app/(app)/[emailAccountId]/cold-email-blocker/ColdEmailRejected";
import { ColdEmailTest } from "@/app/(app)/[emailAccountId]/cold-email-blocker/ColdEmailTest";
import { TabSelect } from "@/components/TabSelect";
import { MessageText } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAccount } from "@/providers/EmailAccountProvider";
import { prefixPath } from "@/utils/path";

const coldEmailTabs = ["cold-emails", "rejected", "test", "settings"] as const;
type ColdEmailTab = (typeof coldEmailTabs)[number];

const defaultTab: ColdEmailTab = "cold-emails";

const tabOptions = [
  { id: "cold-emails", label: "Cold emails" },
  { id: "rejected", label: "Marked not cold" },
  { id: "test", label: "Test" },
  { id: "settings", label: "Settings" },
] satisfies { id: ColdEmailTab; label: string }[];

export function ColdEmailContent() {
  const { emailAccountId } = useAccount();
  const [tab, setTab] = useQueryState("tab", {
    defaultValue: defaultTab,
    history: "push",
  });
  const selectedTab = isColdEmailTab(tab) ? tab : defaultTab;

  return (
    <>
      <div className="border-b border-border">
        <TabSelect
          options={tabOptions}
          selected={selectedTab}
          onSelect={(value: ColdEmailTab) =>
            setTab(value === defaultTab ? null : value)
          }
        />
      </div>

      <div className="mt-4 mb-10">
        {selectedTab === "cold-emails" && (
          <Card>
            <ColdEmailList />
          </Card>
        )}
        {selectedTab === "rejected" && (
          <Card>
            <ColdEmailRejected />
          </Card>
        )}
        {selectedTab === "test" && <ColdEmailTest />}
        {selectedTab === "settings" && (
          <>
            <MessageText className="my-4">
              To manage cold email settings, open the Rules tab and edit the
              Cold Email rule.
            </MessageText>
            <Button asChild variant="outline">
              <Link href={prefixPath(emailAccountId, "/automation?tab=rules")}>
                Go to Rules
              </Link>
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function isColdEmailTab(value: string | null): value is ColdEmailTab {
  return coldEmailTabs.includes(value as ColdEmailTab);
}
