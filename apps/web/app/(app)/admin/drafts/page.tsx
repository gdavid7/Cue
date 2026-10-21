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
  getReplySuggestionFunnel,
  REPLY_SUGGESTION_SOURCES,
  REPLY_SUGGESTION_STAGES,
  SIMILARITY_BUCKETS,
} from "@/utils/reply-tracker/suggestion-funnel";

const STAGE_LABELS: Record<(typeof REPLY_SUGGESTION_STAGES)[number], string> = {
  generated: "Written",
  shown: "Shown in the reader",
  opened: "Opened in the composer",
  edited: "Edited (became a mailbox draft)",
  sent: "Sent",
  dismissed: "Dismissed",
};

const SOURCE_LABELS: Record<(typeof REPLY_SUGGESTION_SOURCES)[number], string> =
  {
    rule: "By a rule's draft action",
    predraft: "Pre-drafted for mail needing a reply",
  };

const BUCKET_LABELS: Record<(typeof SIMILARITY_BUCKETS)[number], string> = {
  unchanged: "Sent as written (95%+ similar)",
  light: "Sent lightly edited (70–95%)",
  heavy: "Sent mostly rewritten (under 70%)",
};

export default async function AdminDraftFunnelPage() {
  const session = await auth(undefined, { disableCookieCache: true });

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  const { windows, truncated } = await getReplySuggestionFunnel();

  return (
    <PageWrapper>
      <PageHeader
        title="Draft funnel"
        description="Where Cue's suggested replies got to, for those written in each window. Rates are of the replies written."
      />
      {truncated && (
        <p className="mt-4 text-muted-foreground text-sm">
          Counted from the newest 100,000 suggestions only.
        </p>
      )}
      <div className="mt-6 overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              {windows.map(({ days }) => (
                <TableHead className="text-right" key={days}>
                  Last {days} days
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {REPLY_SUGGESTION_STAGES.map((stage) => (
              <TableRow key={stage}>
                <TableCell className="font-medium">
                  {STAGE_LABELS[stage]}
                </TableCell>
                {windows.map(({ days, counts }) => (
                  <TableCell className="text-right tabular-nums" key={days}>
                    {formatCount(counts[stage], counts.generated)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {SIMILARITY_BUCKETS.map((bucket) => (
              <TableRow key={bucket}>
                <TableCell className="pl-8 text-muted-foreground">
                  {BUCKET_LABELS[bucket]}
                </TableCell>
                {windows.map(({ days, counts, sentBySimilarity }) => (
                  <TableCell
                    className="text-right text-muted-foreground tabular-nums"
                    key={days}
                  >
                    {formatCount(sentBySimilarity[bucket], counts.generated)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {REPLY_SUGGESTION_SOURCES.map((source) => (
        <section className="mt-8" key={source}>
          <h2 className="font-medium text-sm">{SOURCE_LABELS[source]}</h2>
          <div className="mt-2 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  {windows.map(({ days }) => (
                    <TableHead className="text-right" key={days}>
                      Last {days} days
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {REPLY_SUGGESTION_STAGES.map((stage) => (
                  <TableRow key={stage}>
                    <TableCell>{STAGE_LABELS[stage]}</TableCell>
                    {windows.map(({ days, bySource }) => (
                      <TableCell className="text-right tabular-nums" key={days}>
                        {formatCount(
                          bySource[source][stage],
                          bySource[source].generated,
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </PageWrapper>
  );
}

function formatCount(count: number, generated: number) {
  if (!generated) return String(count);
  return `${count.toLocaleString()} (${Math.round((count / generated) * 100)}%)`;
}
