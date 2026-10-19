"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastError } from "@/components/Toast";
import { setFeedbackStatusAction } from "@/utils/actions/feedback";
import { getActionErrorMessage } from "@/utils/error";

type FeedbackStatus = "NEW" | "SEEN" | "DONE";

type FeedbackRow = {
  id: string;
  createdAt: Date;
  message: string;
  page: string | null;
  status: FeedbackStatus;
  user: { email: string };
  emailAccount: { email: string } | null;
};

const STATUS_ACTIONS: { status: FeedbackStatus; label: string }[] = [
  { status: "NEW", label: "New" },
  { status: "SEEN", label: "Seen" },
  { status: "DONE", label: "Done" },
];

export function FeedbackList({ feedback }: { feedback: FeedbackRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(id: string, status: FeedbackStatus) {
    setBusyId(id);
    const result = await setFeedbackStatusAction({ id, status });
    setBusyId(null);
    if (result?.serverError || result?.validationErrors) {
      toastError({ description: getActionErrorMessage(result) });
      return;
    }
    router.refresh();
  }

  if (feedback.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground text-sm">
        No feedback yet.
      </p>
    );
  }

  return (
    <div className="mt-6 overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Page</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Set status</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {feedback.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.user.email}</TableCell>
              <TableCell>{row.emailAccount?.email ?? "—"}</TableCell>
              <TableCell className="font-mono text-xs">
                {row.page ?? "—"}
              </TableCell>
              <TableCell className="min-w-64 max-w-xl whitespace-pre-wrap break-words">
                {row.message}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDistanceToNow(new Date(row.createdAt), {
                  addSuffix: true,
                })}
              </TableCell>
              <TableCell>
                <Badge variant="muted" size="sm">
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {STATUS_ACTIONS.filter(
                    (action) => action.status !== row.status,
                  ).map((action) => (
                    <Button
                      key={action.status}
                      size="xs-2"
                      variant="outline"
                      disabled={busyId === row.id}
                      onClick={() => setStatus(row.id, action.status)}
                    >
                      Mark {action.label.toLowerCase()}
                    </Button>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
