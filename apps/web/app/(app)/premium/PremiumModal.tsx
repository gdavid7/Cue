import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { env } from "@/env";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/Loading";
import { tiers } from "@/app/(app)/premium/config";
import { loadChunk } from "@/utils/load-chunk";

// Pricing pulls in Headless UI and its virtualizer. Pages such as mail mount
// this hook on load but rarely open the modal, so it loads on first open.
const Pricing = dynamic(
  () => loadChunk(() => import("@/app/(app)/premium/Pricing")),
  {
    loading: () => <Loading />,
  },
);

const modalTiers = tiers.filter((tier) => tier.name !== "Enterprise");

function PricingDialogHeader() {
  return (
    <div className="mb-4 text-center">
      <h2 className="font-title text-2xl text-foreground">
        Upgrade to Premium
      </h2>
    </div>
  );
}

function EnterpriseFooter() {
  return (
    <div className="flex items-center justify-between rounded-3xl border border-border bg-card p-4">
      <div>
        <h3 className="font-semibold text-foreground">Enterprise</h3>
        <p className="text-sm text-muted-foreground">
          SSO, SCIM, on-premise deployment, and dedicated support for large
          teams.
        </p>
      </div>
      <Button variant="outline" asChild>
        <Link href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}>
          Speak to Sales
        </Link>
      </Button>
    </div>
  );
}

export function usePremiumModal() {
  const [isOpen, setIsOpen] = useState(false);

  const openModal = useCallback(() => setIsOpen(true), []);

  const PremiumModal = useCallback(() => {
    return (
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        {/* premium upgrade doesn't support dark mode yet as it appears on homepage */}
        <DialogContent className="max-w-6xl">
          <Pricing
            header={<PricingDialogHeader />}
            displayTiers={modalTiers}
            className="px-0 pt-0 lg:px-0"
          />
          <EnterpriseFooter />
        </DialogContent>
      </Dialog>
    );
  }, [isOpen]);

  return {
    openModal,
    PremiumModal,
  };
}
