"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  CreditCardIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useUser } from "@/hooks/useUser";
import { isPremiumRecord } from "@/utils/premium";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/utils";
import { HoverCard } from "@/components/HoverCard";
import { MutedText } from "@/components/Typography";
import { BRAND_NAME } from "@/utils/branding";
import type { PremiumTier } from "@/generated/prisma/enums";

interface PremiumData {
  appleExpiresAt?: Date | string | null;
  appleRevokedAt?: Date | string | null;
  appleSubscriptionStatus?: string | null;
  lemonSqueezyRenewsAt?: Date | string | null;
  lemonSqueezySubscriptionId?: number | string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  tier?: PremiumTier | null;
}

interface PremiumExpiredCardProps {
  onDismiss?: () => void;
  premium: PremiumData | null | undefined;
}

export function PremiumExpiredCardContent({
  premium,
  onDismiss,
  isCollapsed = false,
}: PremiumExpiredCardProps & { isCollapsed?: boolean }) {
  const lemonSqueezyRenewsAt = premium?.lemonSqueezyRenewsAt
    ? typeof premium.lemonSqueezyRenewsAt === "string"
      ? new Date(premium.lemonSqueezyRenewsAt)
      : premium.lemonSqueezyRenewsAt
    : null;

  const isUserPremium = isPremiumRecord(premium);

  if (isUserPremium) return null;

  const getSubscriptionMessage = () => {
    const UPGRADE_MESSAGE = {
      title: `Get more from ${BRAND_NAME}`,
      description:
        "Premium adds AI sorting, replies drafted in your voice, and meeting briefs.",
    };

    if (!premium) {
      return UPGRADE_MESSAGE;
    }

    const status = premium.stripeSubscriptionStatus;
    const hasLemonSqueezyExpired =
      lemonSqueezyRenewsAt && lemonSqueezyRenewsAt < new Date();

    // Check if user never had a subscription
    const hasNoSubscription =
      !status &&
      !premium.stripeSubscriptionId &&
      !premium.lemonSqueezySubscriptionId;

    if (hasNoSubscription) return UPGRADE_MESSAGE;

    if (status === "past_due") {
      return {
        title: "Payment past due",
        description: "Update your payment method to keep AI features running.",
      };
    }

    if (status === "canceled" || status === "cancelled") {
      return {
        title: "Subscription canceled",
        description: "Reactivate to turn AI features back on.",
      };
    }

    if (status === "incomplete" || status === "incomplete_expired") {
      return {
        title: "Payment incomplete",
        description: "Finish checkout to turn on AI features.",
      };
    }

    if (status === "unpaid") {
      return {
        title: "Payment required",
        description: "Update your payment method to keep AI features running.",
      };
    }

    if (hasLemonSqueezyExpired || status === "expired") {
      return {
        title: "Subscription expired",
        description: "Renew to turn AI features back on.",
      };
    }

    // Default fallback
    return {
      title: "Check your subscription",
      description:
        "Something is off with your subscription. Open Settings to review it.",
    };
  };

  const { title, description } = getSubscriptionMessage();

  const isNewUser =
    !premium ||
    (!premium.stripeSubscriptionStatus &&
      !premium.stripeSubscriptionId &&
      !premium.lemonSqueezySubscriptionId);

  const buttonText = isNewUser ? "Upgrade" : "Reactivate";
  const buttonHref = isNewUser ? "/premium" : "/settings";
  // A plain upsell is an offer, not a problem: only real billing failures get
  // warning styling.
  const Icon = isNewUser ? SparklesIcon : AlertTriangleIcon;
  const iconClassName = isNewUser
    ? "text-muted-foreground"
    : "text-orange-600 dark:text-orange-400";

  const action = (
    <Button
      asChild
      size="sm"
      variant={isNewUser ? "outline" : "default"}
      className="w-full"
    >
      <Link href={buttonHref}>
        {!isNewUser && <CreditCardIcon className="mr-1.5 size-3.5" />}
        {buttonText}
      </Link>
    </Button>
  );

  if (isCollapsed) {
    return (
      <HoverCard
        className="w-64"
        content={
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{title}</p>
            <MutedText>{description}</MutedText>
            <div className="pt-1">{action}</div>
          </div>
        }
      >
        <Link
          href={buttonHref}
          aria-label={title}
          className={cn(
            "flex items-center justify-center rounded-lg p-2 transition-colors",
            isNewUser
              ? "hover:bg-muted"
              : "bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-900/50",
          )}
        >
          <Icon className={cn("size-5", iconClassName)} aria-hidden />
        </Link>
      </HoverCard>
    );
  }

  return (
    <Card
      className={cn(
        "shadow-none",
        !isNewUser &&
          "border-orange-200 bg-orange-50/60 dark:border-orange-900 dark:bg-orange-950/30",
      )}
    >
      <div className="p-3">
        <div className="flex items-start gap-2">
          <Icon
            className={cn("mt-0.5 size-4 flex-shrink-0", iconClassName)}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight text-foreground">
              {title}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>

          {onDismiss && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 size-6 flex-shrink-0 text-muted-foreground"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>

        <div className="mt-3">{action}</div>
      </div>
    </Card>
  );
}
export function PremiumCard({
  isCollapsed = false,
}: {
  isCollapsed?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { data: user, isLoading } = useUser();

  if (isLoading || dismissed || !user) return null;

  return (
    <div className={cn("px-3 pt-4", isCollapsed && "flex justify-center")}>
      <PremiumExpiredCardContent
        premium={user.premium}
        onDismiss={isCollapsed ? undefined : () => setDismissed(true)}
        isCollapsed={isCollapsed}
      />
    </div>
  );
}
