"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestAccessAction } from "@/utils/actions/access";
import {
  requestAccessBody,
  type RequestAccessBody,
} from "@/utils/actions/access.validation";
import { getActionErrorMessage } from "@/utils/error";
import { BRAND_NAME } from "@/utils/branding";

export function RequestAccessForm() {
  const [requestedEmail, setRequestedEmail] = useState<string | null>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setFocus,
    formState: { errors },
  } = useForm<RequestAccessBody>({
    resolver: zodResolver(requestAccessBody),
    defaultValues: { email: "", website: "" },
  });
  const { execute, isExecuting, result, reset } = useAction(
    requestAccessAction,
    {
      onSuccess: () => setRequestedEmail(getValues("email").trim()),
    },
  );
  const serverError = result.serverError
    ? getActionErrorMessage(result, "Couldn't send your request. Try again.")
    : null;

  useEffect(() => {
    if (requestedEmail) confirmationRef.current?.focus();
  }, [requestedEmail]);

  if (requestedEmail) {
    return (
      <div role="status" className="space-y-3">
        <h2
          ref={confirmationRef}
          tabIndex={-1}
          className="font-semibold text-foreground text-lg outline-none"
        >
          You&apos;re on the list
        </h2>
        <p className="text-muted-foreground text-sm">
          We&apos;ll email{" "}
          <span className="font-medium text-foreground">{requestedEmail}</span>{" "}
          when your spot opens. Then come back here and continue with Google
          using that address.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3"
          onClick={() => {
            reset();
            setRequestedEmail(null);
            // Wait for the form to render again before focusing it.
            requestAnimationFrame(() => setFocus("email"));
          }}
        >
          Use a different address
        </Button>
      </div>
    );
  }

  return (
    <form
      noValidate
      aria-labelledby="request-access-heading"
      onSubmit={handleSubmit((data) => execute(data))}
      className="space-y-3"
    >
      <h2
        id="request-access-heading"
        className="font-semibold text-foreground text-lg"
      >
        Request access
      </h2>
      <div className="space-y-1.5">
        <Label htmlFor="request-access-email">Google account email</Label>
        <Input
          id="request-access-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@gmail.com or you@school.edu"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={
            errors.email
              ? "request-access-email-error"
              : "request-access-email-help"
          }
          {...register("email")}
        />
        {errors.email ? (
          <p
            id="request-access-email-error"
            className="text-destructive text-sm"
          >
            {errors.email.message}
          </p>
        ) : (
          <p
            id="request-access-email-help"
            className="text-muted-foreground text-xs"
          >
            Use the Google account you&apos;ll sign in with.
          </p>
        )}
      </div>
      {/* Hidden from people; bots that fill every field get dropped. */}
      <div aria-hidden="true" className="hidden">
        <label htmlFor="request-access-website">Website</label>
        <input
          id="request-access-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          {...register("website")}
        />
      </div>
      {serverError && (
        <p role="alert" className="text-destructive text-sm">
          {serverError}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={isExecuting}>
        Request access
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed">
        We only use this to review your request and email you about access.{" "}
        {BRAND_NAME} doesn&apos;t touch your mailbox until you&apos;re approved
        and sign in.{" "}
        <Link
          href="/privacy"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Privacy
        </Link>
      </p>
    </form>
  );
}
