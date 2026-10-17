"use client";

import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { useAction } from "next-safe-action/hooks";
import useSWR from "swr";
import type { VacationResponderResponse } from "@/app/api/user/vacation-responder/route";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { updateVacationResponderAction } from "@/utils/actions/vacation-responder";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getActionErrorMessage } from "@/utils/error";
import { getAccountScopedKey } from "@/utils/swr";

/** The provider's own out-of-office reply, so it works even with the app closed. */
export function VacationResponderSetting({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string;
}) {
  const { data, isLoading, error, mutate } = useSWR<VacationResponderResponse>(
    getAccountScopedKey("/api/user/vacation-responder", emailAccountId),
  );

  return (
    <>
      <ItemSeparator />
      <LoadingContent
        hasData={Boolean(data)}
        loading={isLoading}
        error={error}
        // A provider that can't be read shouldn't take over the settings page.
        errorComponent={
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Vacation responder</ItemTitle>
              <ItemDescription>
                Couldn&apos;t load your auto-reply settings from your email
                provider. Try again later.
              </ItemDescription>
            </ItemContent>
          </Item>
        }
      >
        {data && (
          <VacationResponderForm
            // Remounts with the saved values once they change on the server.
            key={JSON.stringify(data)}
            emailAccountId={emailAccountId}
            hasSubject={isGoogleProvider(provider)}
            initial={data}
            onSaved={() => mutate()}
          />
        )}
      </LoadingContent>
    </>
  );
}

type VacationForm = {
  enabled: boolean;
  subject: string;
  message: string;
  firstDay: string;
  lastDay: string;
};

function VacationResponderForm({
  emailAccountId,
  hasSubject,
  initial,
  onSaved,
}: {
  emailAccountId: string;
  hasSubject: boolean;
  initial: VacationResponderResponse;
  onSaved: () => void;
}) {
  const { register, handleSubmit, watch, setValue, formState } =
    useForm<VacationForm>({
      defaultValues: {
        enabled: initial.enabled,
        subject: initial.subject,
        message: initial.message,
        firstDay: toDayInput(initial.startTime),
        lastDay: toDayInput(initial.endTime),
      },
    });
  const enabled = watch("enabled");
  const { executeAsync, isExecuting } = useAction(
    updateVacationResponderAction.bind(null, emailAccountId),
  );

  const save = handleSubmit(async (values) => {
    const result = await executeAsync({
      enabled: values.enabled,
      subject: values.subject,
      message: values.message,
      startTime: values.firstDay ? new Date(`${values.firstDay}T00:00`) : null,
      endTime: values.lastDay ? new Date(`${values.lastDay}T23:59:59`) : null,
    });
    if (result?.serverError || result?.validationErrors) {
      toastError({ description: getActionErrorMessage(result) });
      return;
    }
    toastSuccess({
      description: values.enabled
        ? "Vacation responder is on"
        : "Vacation responder is off",
    });
    onSaved();
  });

  return (
    <form onSubmit={save}>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Vacation responder</ItemTitle>
          <ItemDescription>
            Automatically reply to people who email you while you&apos;re away.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label="Toggle vacation responder"
            checked={enabled}
            onCheckedChange={(checked) =>
              setValue("enabled", checked, { shouldDirty: true })
            }
          />
        </ItemActions>
      </Item>
      {(enabled || formState.isDirty) && (
        <div className="grid gap-3 px-4 pb-4">
          {enabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${emailAccountId}-vacation-first-day`}>
                    First day (optional)
                  </Label>
                  <Input
                    id={`${emailAccountId}-vacation-first-day`}
                    type="date"
                    {...register("firstDay")}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${emailAccountId}-vacation-last-day`}>
                    Last day (optional)
                  </Label>
                  <Input
                    id={`${emailAccountId}-vacation-last-day`}
                    type="date"
                    {...register("lastDay")}
                  />
                </div>
              </div>
              {hasSubject && (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${emailAccountId}-vacation-subject`}>
                    Subject
                  </Label>
                  <Input
                    id={`${emailAccountId}-vacation-subject`}
                    placeholder="Out of office"
                    {...register("subject")}
                  />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor={`${emailAccountId}-vacation-message`}>
                  Message
                </Label>
                <Textarea
                  id={`${emailAccountId}-vacation-message`}
                  rows={4}
                  placeholder="I'm away until Monday and will reply when I'm back."
                  {...register("message")}
                />
              </div>
            </>
          )}
          <div>
            <Button
              disabled={!formState.isDirty}
              loading={isExecuting}
              size="sm"
              type="submit"
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function toDayInput(value: string | null) {
  return value ? format(new Date(value), "yyyy-MM-dd") : "";
}
