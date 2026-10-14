"use client";

import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Trash2Icon,
  XCircle,
  ChevronDown,
  MoreHorizontalIcon,
} from "lucide-react";
import { CalendarList } from "./CalendarList";
import { useAction } from "next-safe-action/hooks";
import {
  disconnectCalendarAction,
  toggleCalendarAction,
} from "@/utils/actions/calendar";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useCalendars } from "@/hooks/useCalendars";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { toastError, toastSuccess } from "@/components/Toast";
import { captureException, getActionErrorMessage } from "@/utils/error";
import { useState } from "react";
import type { GetCalendarAuthUrlResponse } from "@/app/api/google/calendar/auth-url/route";
import type { GetCalendarsResponse } from "@/app/api/user/calendars/route";
import { fetchWithAccount } from "@/utils/fetch";
import { redirectToSafeUrl } from "@/utils/redirect";
import { TypographyP } from "@/components/Typography";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

type CalendarConnection = GetCalendarsResponse["connections"][0];

interface CalendarConnectionCardProps {
  connection: CalendarConnection;
}

const getProviderInfo = (provider: string) => {
  const providers = {
    microsoft: {
      name: "Microsoft Calendar",
      icon: "/images/product/outlook-calendar.svg",
      alt: "Microsoft Calendar",
    },
    google: {
      name: "Google Calendar",
      icon: "/images/product/google-calendar.svg",
      alt: "Google Calendar",
    },
  };

  return providers[provider as keyof typeof providers] || providers.google;
};

export function CalendarConnectionCard({
  connection,
}: CalendarConnectionCardProps) {
  const { emailAccountId } = useAccount();
  const { data, mutate } = useCalendars();
  const { confirm, dialog } = useConfirmDialog();
  const [optimisticUpdates, setOptimisticUpdates] = useState<
    Record<string, boolean>
  >({});
  const [isOpen, setIsOpen] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const providerInfo = getProviderInfo(connection.provider);

  const calendars = connection.calendars || [];
  const enabledCalendars = calendars.filter((cal) => {
    const optimisticValue = optimisticUpdates[cal.id];
    return optimisticValue !== undefined ? optimisticValue : cal.isEnabled;
  });

  const { execute: executeDisconnect, isExecuting: isDisconnecting } =
    useAction(disconnectCalendarAction.bind(null, emailAccountId), {
      onSuccess: () => {
        toastSuccess({ description: "Calendar disconnected" });
        mutate();
      },
      onError: (error) => {
        toastError({
          title: "Couldn't disconnect calendar",
          description: getActionErrorMessage(error.error),
        });
      },
    });
  const { execute: executeToggle } = useAction(
    toggleCalendarAction.bind(null, emailAccountId),
  );

  const handleDisconnect = async () => {
    if (
      await confirm({
        title: `Disconnect ${connection.email}?`,
        description:
          "Its calendars will no longer be used for availability or meeting briefs. Events stay in your calendar.",
        confirmText: "Disconnect",
      })
    ) {
      executeDisconnect({ connectionId: connection.id });
    }
  };

  // Connecting the same calendar again gives the existing connection fresh
  // tokens.
  const handleReconnect = async () => {
    setIsReconnecting(true);
    try {
      const response = await fetchWithAccount({
        url:
          connection.provider === "microsoft"
            ? "/api/outlook/calendar/auth-url"
            : "/api/google/calendar/auth-url",
        emailAccountId,
        init: { headers: { "Content-Type": "application/json" } },
      });
      if (!response.ok) throw new Error("Failed to start calendar reconnect");
      const { url }: GetCalendarAuthUrlResponse = await response.json();
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      captureException(error, {
        extra: { context: "Calendar reconnect initiation" },
      });
      toastError({
        title: `Couldn't reconnect ${providerInfo.name}`,
        description: "Please try again or contact support",
      });
      setIsReconnecting(false);
    }
  };

  const handleToggleCalendar = async (
    calendarId: string,
    isEnabled: boolean,
  ) => {
    setOptimisticUpdates((prev) => ({ ...prev, [calendarId]: isEnabled }));

    if (data) {
      mutate(
        {
          ...data,
          connections: data.connections.map((conn) =>
            conn.id === connection.id
              ? {
                  ...conn,
                  calendars:
                    conn.calendars?.map((cal) =>
                      cal.id === calendarId ? { ...cal, isEnabled } : cal,
                    ) || [],
                }
              : conn,
          ),
        },
        false,
      );
    }

    try {
      executeToggle({ calendarId, isEnabled });

      setOptimisticUpdates((prev) => {
        const { [calendarId]: _, ...rest } = prev;
        return rest;
      });
    } catch {
      setOptimisticUpdates((prev) => {
        const { [calendarId]: _, ...rest } = prev;
        return rest;
      });
    } finally {
      mutate();
    }
  };

  // TODO: use card - sm variant once we merge the big pr
  return (
    <Card>
      <CardHeader className="p-4">
        <div className="flex items-center justify-between gap-2 sm:gap-0">
          <div className="flex min-w-0 items-center gap-3 max-sm:flex-1">
            <Image
              src={providerInfo.icon}
              alt={providerInfo.alt}
              width={32}
              height={32}
              className="shrink-0"
              unoptimized
            />
            <div className="min-w-0">
              <CardTitle className="text-lg">{providerInfo.name}</CardTitle>
              <CardDescription className="flex items-center gap-2">
                <span className="truncate">{connection.email}</span>
                {!connection.isConnected && (
                  <div className="flex shrink-0 items-center gap-1 text-red-600 dark:text-red-400">
                    <XCircle className="h-3 w-3" />
                    <span className="text-xs">Disconnected</span>
                  </div>
                )}
              </CardDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!connection.isConnected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleReconnect}
                disabled={isReconnecting}
              >
                {isReconnecting ? "Reconnecting..." : "Reconnect"}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  aria-label="Calendar options"
                  disabled={isDisconnecting}
                  variant="ghostMuted"
                  size="iconSm"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    handleDisconnect();
                  }}
                  variant="destructive"
                >
                  <Trash2Icon />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <Separator className="mb-4" />
      <CardContent className="p-4 pt-0">
        {calendars.length > 0 ? (
          <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full text-left"
              >
                <span>
                  {enabledCalendars.length} of {calendars.length} calendars
                  selected for availability
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 space-y-4">
              <CalendarList
                calendars={calendars.map((cal) => ({
                  ...cal,
                  isEnabled:
                    optimisticUpdates[cal.id] !== undefined
                      ? optimisticUpdates[cal.id]
                      : cal.isEnabled,
                }))}
                onToggleCalendar={handleToggleCalendar}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <TypographyP className="text-sm">
            No calendars found. Your calendars will be synced automatically.
          </TypographyP>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}
