"use client";

import { useRef, useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { adminPiiCleanupAction } from "@/utils/actions/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";

type Counts = Record<string, number>;

export function PrivacyCleanup({
  chatSdkRedis,
}: {
  chatSdkRedis: "same" | "different" | "unknown";
}) {
  const [planned, setPlanned] = useState<Counts | null>(null);
  const [deleted, setDeleted] = useState<Counts>({});
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [counting, setCounting] = useState(false);
  const [running, setRunning] = useState(false);
  const stopRequested = useRef(false);

  const { executeAsync } = useAction(adminPiiCleanupAction);

  const deleting = running;
  const deleteStarted = resumeCursor !== null || finished;

  async function countLeftoverKeys() {
    setCounting(true);
    setPlanned(null);
    setDeleted({});
    setResumeCursor(null);
    setFinished(false);

    let totals: Counts = {};
    let cursor: string | null = null;
    do {
      const result = await executeAsync({ mode: "dry-run", cursor });
      if (!result?.data) {
        toastError({
          title: "Could not count the keys",
          description: getActionErrorMessage({
            serverError: result?.serverError,
          }),
        });
        setCounting(false);
        return;
      }
      totals = addCounts(totals, result.data.counts);
      setPlanned(totals);
      cursor = result.data.nextCursor;
    } while (cursor);
    setCounting(false);
  }

  async function deleteThem() {
    setConfirming(false);
    stopRequested.current = false;
    setRunning(true);

    let cursor = resumeCursor;
    do {
      const result = await executeAsync({ mode: "delete", cursor });
      if (!result?.data) {
        toastError({
          title: "The cleanup stopped",
          description: getActionErrorMessage({
            serverError: result?.serverError,
          }),
        });
        setRunning(false);
        return;
      }
      const { counts, nextCursor } = result.data;
      setDeleted((previous) => addCounts(previous, counts));
      setResumeCursor(nextCursor);
      cursor = nextCursor;
    } while (cursor && !stopRequested.current);

    setRunning(false);
    if (!cursor) {
      setFinished(true);
      toastSuccess({ description: "Cleanup finished" });
    }
  }

  return (
    <div className="mt-4 max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        {chatSdkRedis === "same"
          ? "The Chat SDK keys (REDIS_URL) and this cleanup (REDIS_HTTP_URL) point at the same host."
          : `The Chat SDK keys live on REDIS_URL; this cleanup only reaches the REDIS_HTTP_URL database. ${
              chatSdkRedis === "different"
                ? "They point at different hosts, so run the script against REDIS_URL too."
                : "Could not tell whether they are the same database; if they are not, run the script against REDIS_URL too."
            }`}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>1. Count leftover keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Counts the keys per pattern. Nothing is changed. The last two
            patterns are rewritten rather than deleted.
          </p>
          <Button
            variant="outline"
            onClick={countLeftoverKeys}
            loading={counting}
            disabled={deleting}
          >
            Count leftover keys
          </Button>
          {planned && (
            <CountTable
              counts={planned}
              heading={counting ? "Counting" : "Found"}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Delete them</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Deletes the keys counted above, batch after batch, until it is done
            or you press Stop. After a stop or an error, click again to
            continue.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => setConfirming(true)}
              loading={deleting}
              disabled={!planned || counting || finished}
            >
              {resumeCursor ? "Run again to continue" : "Delete them"}
            </Button>
            {deleting && (
              <Button
                variant="outline"
                onClick={() => {
                  stopRequested.current = true;
                }}
              >
                Stop
              </Button>
            )}
          </div>
          {deleteStarted && (
            <p className="text-sm">
              {finished
                ? "Finished. Count again to confirm nothing is left."
                : "Not finished yet. Run again to continue where it stopped."}
            </p>
          )}
          {deleteStarted && (
            <CountTable counts={deleted} heading="Done so far" />
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete these keys?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Lifetime usage counters not yet moved to
              the account's key are lost with them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {planned && <CountTable counts={planned} heading="To be removed" />}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteThem}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CountTable({ counts, heading }: { counts: Counts; heading: string }) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return (
    <div className="max-h-80 overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{heading}: pattern</TableHead>
            <TableHead className="text-right">Keys</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(counts).map(([pattern, count]) => (
            <TableRow key={pattern}>
              <TableCell className="font-mono text-xs">{pattern}</TableCell>
              <TableCell className="text-right">{count}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-medium">Total</TableCell>
            <TableCell className="text-right font-medium">{total}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function addCounts(a: Counts, b: Counts) {
  const sum = { ...a };
  for (const [pattern, count] of Object.entries(b))
    sum[pattern] = (sum[pattern] ?? 0) + count;
  return sum;
}
