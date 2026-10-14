"use client";

import { type FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastError, toastSuccess } from "@/components/Toast";
import {
  approveAccessEmailAction,
  approveAccessRequestsAction,
  declineAccessRequestAction,
  importAllowlistAction,
  markAccessRequestNotifiedAction,
} from "@/utils/actions/access";
import {
  getApprovalEmail,
  getApprovalMailtoUrl,
} from "@/utils/access/approval-email";
import {
  GOOGLE_OAUTH_TEST_USERS_URL,
  GOOGLE_OAUTH_TESTING_MODE,
} from "@/utils/access/config";
import { getActionErrorMessage } from "@/utils/error";
import { cn } from "@/utils";

type AccessRequest = {
  id: string;
  email: string;
  name: string | null;
  source: string;
  status: "PENDING" | "APPROVED" | "DECLINED";
  createdAt: Date;
  decidedAt: Date | null;
  notifiedAt: Date | null;
};

type Approved = { id: string; email: string; emailed: boolean };

const STATUS_TABS = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "DECLINED", label: "Declined" },
] as const;

const SOURCE_LABELS: Record<string, string> = {
  form: "Form",
  google_sign_in: "Google sign-in",
  admin: "Added by you",
  existing_user: "Existing user",
  allowlist: "Allow-list",
};

export function AccessRequests({
  requests,
  senderName,
  baseUrl,
  allowlistCount,
}: {
  requests: AccessRequest[];
  senderName: string | null;
  baseUrl: string;
  allowlistCount: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<AccessRequest["status"]>("PENDING");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Approved[] | null>(null);

  const counts = useMemo(() => {
    const result = { PENDING: 0, APPROVED: 0, DECLINED: 0 };
    for (const request of requests) result[request.status] += 1;
    return result;
  }, [requests]);
  const visible = requests.filter((request) => request.status === status);
  const selectedPending = visible.filter((request) => selected.has(request.id));

  async function approve(ids: string[]) {
    setBusyId(ids.length === 1 ? ids[0] : "bulk");
    const result = await approveAccessRequestsAction({ ids });
    setBusyId(null);
    if (result?.serverError || result?.validationErrors) {
      toastError({ description: getActionErrorMessage(result) });
      return;
    }
    setSelected(new Set());
    setApproved(result?.data?.approved ?? []);
    router.refresh();
  }

  async function decline(id: string) {
    setBusyId(id);
    const result = await declineAccessRequestAction({ id });
    setBusyId(null);
    if (result?.serverError) {
      toastError({ description: getActionErrorMessage(result) });
      return;
    }
    toastSuccess({ description: "Declined. They won't be emailed." });
    router.refresh();
  }

  return (
    <div className="mt-6 space-y-6">
      <ApproveAddressForm
        onApproved={(rows) => {
          setApproved(rows);
          router.refresh();
        }}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-muted-foreground text-sm">
          {counts.APPROVED} approved · {counts.PENDING} pending
        </p>
        {allowlistCount > 0 && (
          <ImportAllowlistButton
            count={allowlistCount}
            onImported={() => router.refresh()}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Request status"
          className="inline-flex rounded-md bg-muted p-1"
        >
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => {
                setStatus(tab.value);
                setSelected(new Set());
              }}
              className={cn(
                "rounded-sm px-3 py-1.5 font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                status === tab.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label} ({counts[tab.value]})
            </button>
          ))}
        </div>
        {status === "PENDING" && selectedPending.length > 0 && (
          <Button
            size="sm"
            loading={busyId === "bulk"}
            onClick={() =>
              approve(selectedPending.map((request) => request.id))
            }
          >
            Approve selected ({selectedPending.length})
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">
          Nothing here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {status === "PENDING" && (
                  <TableHead className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                )}
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((request) => (
                <TableRow key={request.id}>
                  {status === "PENDING" && (
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${request.email}`}
                        checked={selected.has(request.id)}
                        onCheckedChange={(checked) => {
                          const next = new Set(selected);
                          if (checked === true) next.add(request.id);
                          else next.delete(request.id);
                          setSelected(next);
                        }}
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{request.email}</TableCell>
                  <TableCell>{request.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="muted" size="sm">
                      {SOURCE_LABELS[request.source] ?? request.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDistanceToNow(new Date(request.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      request={request}
                      busy={busyId === request.id}
                      onApprove={() => approve([request.id])}
                      onDecline={() => decline(request.id)}
                      onEmail={() =>
                        setApproved([
                          {
                            id: request.id,
                            email: request.email,
                            emailed: false,
                          },
                        ])
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ApprovedDialog
        approved={approved}
        requests={requests}
        senderName={senderName}
        baseUrl={baseUrl}
        onClose={() => setApproved(null)}
        onNotified={() => router.refresh()}
      />
    </div>
  );
}

function RowActions({
  request,
  busy,
  onApprove,
  onDecline,
  onEmail,
}: {
  request: AccessRequest;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onEmail: () => void;
}) {
  if (request.status === "APPROVED") {
    if (request.notifiedAt)
      return <span className="text-muted-foreground text-xs">Notified</span>;
    return (
      <Button size="xs-2" variant="outline" onClick={onEmail}>
        Next steps
      </Button>
    );
  }

  return (
    <div className="flex justify-end gap-1">
      {request.status === "PENDING" && (
        <Button size="xs-2" variant="ghost" disabled={busy} onClick={onDecline}>
          Decline
        </Button>
      )}
      <Button size="xs-2" loading={busy} onClick={onApprove}>
        Approve
      </Button>
    </div>
  );
}

function ImportAllowlistButton({
  count,
  onImported,
}: {
  count: number;
  onImported: () => void;
}) {
  const [isImporting, setIsImporting] = useState(false);

  return (
    <Button
      size="xs-2"
      variant="outline"
      loading={isImporting}
      onClick={async () => {
        setIsImporting(true);
        const result = await importAllowlistAction();
        setIsImporting(false);
        if (result?.serverError) {
          toastError({ description: getActionErrorMessage(result) });
          return;
        }
        toastSuccess({
          description: `Marked ${result?.data?.imported ?? 0} allow-listed addresses as approved. Nobody was emailed.`,
        });
        onImported();
      }}
    >
      Import AUTH_ALLOWED_EMAILS ({count})
    </Button>
  );
}

function ApproveAddressForm({
  onApproved,
}: {
  onApproved: (approved: Approved[]) => void;
}) {
  const [email, setEmail] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    const result = await approveAccessEmailAction({ email });
    setIsSaving(false);
    if (result?.serverError || result?.validationErrors) {
      toastError({ description: getActionErrorMessage(result) });
      return;
    }
    if (result?.data?.alreadyApproved) {
      toastSuccess({ description: "That address is already approved." });
      return;
    }
    setEmail("");
    onApproved(result?.data?.approved ?? []);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex max-w-md flex-col gap-2 sm:flex-row sm:items-end"
    >
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="approve-address">Approve an address</Label>
        <Input
          id="approve-address"
          type="email"
          required
          placeholder="friend@gmail.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <Button type="submit" loading={isSaving}>
        Approve
      </Button>
    </form>
  );
}

function ApprovedDialog({
  approved,
  requests,
  senderName,
  baseUrl,
  onClose,
  onNotified,
}: {
  approved: Approved[] | null;
  requests: AccessRequest[];
  senderName: string | null;
  baseUrl: string;
  onClose: () => void;
  onNotified: () => void;
}) {
  const names = new Map(requests.map((request) => [request.id, request.name]));

  return (
    <Dialog open={!!approved} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {approved?.length === 1
              ? `Approved ${approved[0].email}`
              : `Approved ${approved?.length ?? 0} people`}
          </DialogTitle>
          <DialogDescription>
            {GOOGLE_OAUTH_TESTING_MODE
              ? "Two more steps before they can get in."
              : "One more step before they know they can get in."}
          </DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-4 pl-5 text-sm">
          {GOOGLE_OAUTH_TESTING_MODE && (
            <li>
              <p className="font-medium">Add them as Google test users</p>
              <p className="mt-1 text-muted-foreground">
                Cue&apos;s Google app is in Testing, so Google only lets listed
                test users sign in. Add this exact address under Audience → Test
                users:
              </p>
              <ul className="mt-2 space-y-1 font-mono text-xs">
                {approved?.map((row) => (
                  <li key={row.id}>{row.email}</li>
                ))}
              </ul>
              <Button asChild size="sm" variant="outline" className="mt-2">
                <a
                  href={GOOGLE_OAUTH_TEST_USERS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Cloud Console
                  <ExternalLinkIcon className="ml-1.5 size-3.5" aria-hidden />
                </a>
              </Button>
            </li>
          )}
          <li>
            <p className="font-medium">Let them know</p>
            <ul className="mt-2 space-y-3">
              {approved?.map((row) => (
                <ApprovalEmailRow
                  key={row.id}
                  row={row}
                  name={names.get(row.id) ?? null}
                  senderName={senderName}
                  baseUrl={baseUrl}
                  onNotified={onNotified}
                />
              ))}
            </ul>
          </li>
        </ol>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalEmailRow({
  row,
  name,
  senderName,
  baseUrl,
  onNotified,
}: {
  row: Approved;
  name: string | null;
  senderName: string | null;
  baseUrl: string;
  onNotified: () => void;
}) {
  const [isMarked, setIsMarked] = useState(row.emailed);
  const message = getApprovalEmail({
    email: row.email,
    name,
    baseUrl,
    senderName,
  });

  if (isMarked) {
    return (
      <li className="text-muted-foreground">
        {row.email}:{" "}
        {row.emailed ? "approval email sent" : "marked as notified"}
      </li>
    );
  }

  return (
    <li>
      <p className="font-mono text-xs">{row.email}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <Button asChild size="xs-2" variant="outline">
          <a href={getApprovalMailtoUrl(row.email, message)}>
            Open in mail app
          </a>
        </Button>
        <Button
          size="xs-2"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${message.subject}\n\n${message.body}`,
              );
              toastSuccess({ description: "Approval email copied" });
            } catch {
              toastError({ description: "Couldn't copy. Use the mail app." });
            }
          }}
        >
          Copy email
        </Button>
        <Button
          size="xs-2"
          variant="ghost"
          onClick={async () => {
            const result = await markAccessRequestNotifiedAction({
              id: row.id,
            });
            if (result?.serverError) {
              toastError({ description: getActionErrorMessage(result) });
              return;
            }
            setIsMarked(true);
            onNotified();
          }}
        >
          Mark as sent
        </Button>
      </div>
    </li>
  );
}
