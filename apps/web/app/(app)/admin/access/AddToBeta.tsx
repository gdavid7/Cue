"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  approveAccessEmailAction,
  markAccessRequestNotifiedAction,
} from "@/utils/actions/access";
import {
  BETA_SIGN_IN_URL,
  GOOGLE_OAUTH_TEST_USERS_URL,
  GMAIL_DOMAINS,
  GOOGLE_OAUTH_TESTING_MODE,
} from "@/utils/access/config";
import { BRAND_NAME } from "@/utils/branding";
import { getActionErrorMessage } from "@/utils/error";
import { cn } from "@/utils";

type Added = {
  id: string;
  email: string;
  alreadyApproved: boolean;
  emailed: boolean;
};

export function AddToBeta() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    const result = await approveAccessEmailAction({ email });
    setIsSaving(false);
    if (result?.serverError || result?.validationErrors || !result?.data) {
      toastError({ description: getActionErrorMessage(result ?? {}) });
      return;
    }
    setEmail("");
    setAdded({
      id: result.data.id,
      email: result.data.email,
      alreadyApproved: result.data.alreadyApproved,
      emailed: result.data.approved[0]?.emailed ?? false,
    });
    router.refresh();
  }

  return (
    <Card className="mt-6">
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="text-lg">Add someone to the beta</CardTitle>
        <CardDescription>
          They can sign up as soon as you add them. They sign in with Google, so
          use their Gmail or a Google Workspace (school or work) account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 p-4 pt-0 sm:p-6 sm:pt-0">
        <form onSubmit={onSubmit} className="flex max-w-md items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="add-to-beta-email">Email</Label>
            <Input
              id="add-to-beta-email"
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="friend@gmail.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" loading={isSaving}>
            Add
          </Button>
        </form>

        {added && <AddedChecklist key={added.email} added={added} />}
      </CardContent>
    </Card>
  );
}

function AddedChecklist({ added }: { added: Added }) {
  const router = useRouter();
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(added.emailed);
  const invite = getInviteText(added.email);

  return (
    <div className="border-t pt-5">
      <p role="status" className="break-all font-medium text-sm">
        {added.alreadyApproved
          ? `${added.email} is already in the beta`
          : `${added.email} is in`}
      </p>
      {!isGmailAddress(added.email) && (
        <p className="mt-2 flex gap-2 text-amber-700 text-sm dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          Not a Gmail address — they&apos;ll need a Google Workspace account at
          that address to sign in.
        </p>
      )}
      <ol className="mt-4 space-y-4">
        <Step number={1} done title="Approved in Cue" />
        {GOOGLE_OAUTH_TESTING_MODE && (
          <Step
            number={2}
            done={copiedEmail}
            title="Add as a Google test user"
            description="Google only lets listed test users sign in while the app is in Testing. Paste the address under Audience → Test users."
          >
            <Button asChild size="sm" variant="outline">
              <a
                href={GOOGLE_OAUTH_TEST_USERS_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  // Started inside the click so it runs before the new tab
                  // takes focus; the tab opens either way.
                  navigator.clipboard.writeText(added.email).then(
                    () => {
                      setCopiedEmail(true);
                      toastSuccess({ description: "Email copied" });
                    },
                    () =>
                      toastError({
                        description: `Couldn't copy. The address is ${added.email}.`,
                      }),
                  );
                }}
              >
                Copy email and open Google
                <ExternalLinkIcon className="ml-1.5 size-3.5" aria-hidden />
              </a>
            </Button>
          </Step>
        )}
        <Step
          number={GOOGLE_OAUTH_TESTING_MODE ? 3 : 2}
          done={copiedInvite}
          title="Let them know"
          description={
            added.emailed ? "An approval email was sent from your mailbox." : ""
          }
        >
          <div className="rounded-md border bg-muted/50 p-3">
            <p className="whitespace-pre-wrap break-words text-sm">{invite}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite);
              } catch {
                toastError({ description: "Couldn't copy. Select the text." });
                return;
              }
              setCopiedInvite(true);
              toastSuccess({ description: "Invite copied" });
              // Copying the invite is how the founder tells people, so the
              // list stops offering "Next steps" for them.
              await markAccessRequestNotifiedAction({ id: added.id });
              router.refresh();
            }}
          >
            <CopyIcon className="mr-1.5 size-3.5" aria-hidden />
            Copy invite
          </Button>
        </Step>
      </ol>
    </div>
  );
}

function Step({
  number,
  done,
  title,
  description,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-xs tabular-nums",
          done
            ? "border-transparent bg-green-600/10 text-green-600 dark:bg-green-400/15 dark:text-green-400"
            : "text-muted-foreground",
        )}
      >
        {done ? (
          <CheckIcon className="size-3.5" aria-label="Done" />
        ) : (
          <span aria-hidden>{number}</span>
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="font-medium text-sm">{title}</p>
        {description && (
          <p className="mt-1 text-muted-foreground text-sm">{description}</p>
        )}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

function getInviteText(email: string) {
  return `You're in the ${BRAND_NAME} beta! Sign in with Google as ${email}: ${BETA_SIGN_IN_URL}`;
}

function isGmailAddress(email: string) {
  return GMAIL_DOMAINS.includes(email.split("@").pop() ?? "");
}
