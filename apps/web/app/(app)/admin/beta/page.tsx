import { auth } from "@/utils/auth";
import { isAdmin } from "@/utils/admin";
import { ErrorPage } from "@/components/ErrorPage";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getBetaTesters,
  LAST_PROCESSED_LOOKBACK_DAYS,
  SUGGESTION_WINDOW_DAYS,
} from "@/app/(app)/admin/beta/get-beta-testers";

const CHECKLIST_STATUS_LABELS = {
  active: "",
  done: "all done",
  dismissed: "hidden",
  expired: "week over",
} as const;

export default async function AdminBetaTestersPage() {
  const session = await auth();

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  const now = new Date();
  const { testers } = await getBetaTesters(now);

  return (
    <PageWrapper>
      <PageHeader
        title="Beta testers"
        description={`How each person's Cue is doing. Counts and dates only. Suggested replies are those written in the last ${SUGGESTION_WINDOW_DAYS} days.`}
      />
      <div className="mt-6 overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Accounts</TableHead>
              <TableHead>
                Last mail processed ({LAST_PROCESSED_LOOKBACK_DAYS}d)
              </TableHead>
              <TableHead className="text-right">Errors (24h)</TableHead>
              <TableHead>Sync issues</TableHead>
              <TableHead>Get started</TableHead>
              <TableHead className="text-right">Suggestions shown</TableHead>
              <TableHead className="text-right">Sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {testers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground">
                  No one has signed up yet.
                </TableCell>
              </TableRow>
            ) : null}
            {testers.map((tester) => (
              <TableRow key={tester.id}>
                <TableCell>
                  <div className="font-medium">
                    {tester.name || tester.email}
                  </div>
                  {tester.name ? (
                    <div className="text-muted-foreground text-xs">
                      {tester.email}
                    </div>
                  ) : null}
                  <div className="text-muted-foreground text-xs">
                    Joined {formatAgo(tester.joinedAt, now)}
                  </div>
                </TableCell>
                <TableCell>{formatAgo(tester.lastActiveAt, now)}</TableCell>
                <TableCell>
                  {tester.providers.length}
                  {tester.providers.length ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({tester.providers.join(", ")})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {tester.lastProcessedAt
                    ? formatAgo(tester.lastProcessedAt, now)
                    : "None"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {tester.errorsLast24h}
                </TableCell>
                <TableCell>
                  {tester.syncIssues.length ? (
                    tester.syncIssues.join(", ")
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {tester.checklist.done}/{tester.checklist.total}
                  {CHECKLIST_STATUS_LABELS[tester.checklist.status] ? (
                    <span className="text-muted-foreground">
                      {" "}
                      {CHECKLIST_STATUS_LABELS[tester.checklist.status]}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {tester.suggestions.shown}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {tester.suggestions.sent}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </PageWrapper>
  );
}

function formatAgo(date: Date | null, now: Date) {
  if (!date) return "Never";
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 60) return minutes <= 1 ? "Just now" : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
