"use client";

import Image from "next/image";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { logOut } from "@/utils/user";
import { env } from "@/env";

export function ErrorDisplay(props: {
  error:
    | {
        info?: { error?: string | object; isKnownError?: boolean };
        error?: string | object;
      }
    | undefined;
  /** Defaults to revalidating the data on screen. */
  onRetry?: () => void;
}) {
  const { mutate } = useSWRConfig();
  if (!props.error) return null;

  const errorMessage =
    safeErrorToString(props.error.info?.error) ||
    safeErrorToString(props.error.error);
  // Known errors were written for the user; anything else is system detail.
  const userMessage = props.error.info?.isKnownError ? errorMessage : null;
  const retry = props.onRetry ?? (() => mutate(() => true));

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10">
          <AlertCircle className="text-destructive" />
        </EmptyMedia>
        <EmptyTitle>Couldn&apos;t load this</EmptyTitle>
        <EmptyDescription>
          {userMessage || (
            <>
              Check your connection and try again. If it keeps happening, email{" "}
              <a href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}>
                {env.NEXT_PUBLIC_SUPPORT_EMAIL}
              </a>
              .
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={retry}>
          <RotateCcw className="size-4" />
          Try again
        </Button>
        {errorMessage && !userMessage ? (
          <details className="max-w-full text-muted-foreground text-xs">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1 break-words">{errorMessage}</p>
          </details>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}

export const NotLoggedIn = () => (
  <div className="flex flex-col items-center justify-center sm:p-20 md:p-32">
    <div className="text-lg text-gray-700">You are not signed in 😞</div>
    <Button variant="outline" className="mt-2" onClick={() => logOut("/login")}>
      Sign in
    </Button>
    <div className="mt-8">
      <Image
        src="/images/illustrations/falling.svg"
        alt=""
        width={400}
        height={400}
        unoptimized
        className="dark:brightness-90 dark:invert"
      />
    </div>
  </div>
);

const safeErrorToString = (
  error: string | object | undefined,
): string | null => {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    // Handle Zod validation errors with issues array
    if ("issues" in error && Array.isArray(error.issues)) {
      return error.issues
        .map((issue) => issue.message || "Validation error")
        .join(", ");
    }
    // For other objects, try to stringify safely
    try {
      return JSON.stringify(error);
    } catch {
      return "Invalid data format";
    }
  }
  return String(error);
};
