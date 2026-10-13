"use client";

import { useAction } from "next-safe-action/hooks";
import { useForm } from "react-hook-form";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectWithCredentialsAction } from "@/utils/actions/mcp";
import { getActionErrorMessage } from "@/utils/error";
import type { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";

type CredentialField = NonNullable<
  (typeof MCP_INTEGRATIONS)[string]["credentialFields"]
>[number];

/**
 * Connects an app that takes a key instead of a sign-in page, such as Canvas
 * with a school's address and a personal access token. The app checks the key
 * before anything is saved.
 */
export function ConnectWithCredentialsDialog({
  open,
  onOpenChange,
  emailAccountId,
  integration,
  displayName,
  fields,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailAccountId: string;
  integration: string;
  displayName: string;
  fields: CredentialField[];
  onConnected: () => void;
}) {
  const { register, handleSubmit, reset } = useForm<Record<string, string>>();
  const { executeAsync, isExecuting } = useAction(
    connectWithCredentialsAction.bind(null, emailAccountId),
  );

  const submit = handleSubmit(async (credentials) => {
    const result = await executeAsync({ integration, credentials });
    if (result?.serverError || result?.validationErrors) {
      toastError({
        description: getActionErrorMessage(result, {
          prefix: `Couldn't connect ${displayName}`,
        }),
      });
      return;
    }
    toastSuccess({ description: `${displayName} connected` });
    reset();
    onOpenChange(false);
    onConnected();
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {displayName}</DialogTitle>
          <DialogDescription>
            Cue reads {displayName} so related items show up next to your email.
            It never posts or changes anything there.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {fields.map((field) => (
            <div className="space-y-1.5" key={field.name}>
              <Label htmlFor={`credential-${field.name}`}>{field.label}</Label>
              <Input
                autoComplete="off"
                id={`credential-${field.name}`}
                placeholder={field.placeholder}
                type={field.secret ? "password" : "text"}
                {...register(field.name, { required: true })}
              />
              <p className="text-muted-foreground text-xs">
                {field.description}
              </p>
            </div>
          ))}
          <DialogFooter>
            <Button loading={isExecuting} type="submit">
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
