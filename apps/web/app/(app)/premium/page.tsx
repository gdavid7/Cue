import { redirect } from "next/navigation";
import { AppPricingLazy } from "@/app/(app)/premium/AppPricingLazy";
import { env } from "@/env";

export default function Premium() {
  // Every feature is already unlocked, so there is no plan to choose.
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) redirect("/settings");

  return (
    <div className="bg-white pb-20">
      <AppPricingLazy showSkipUpgrade />
    </div>
  );
}
