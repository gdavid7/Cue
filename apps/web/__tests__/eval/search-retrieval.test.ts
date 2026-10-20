import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { judgeEvalOutput } from "@/__tests__/eval/semantic-judge";
import {
  ACCOUNT_ID,
  conversationOf,
  FIXTURE_EMAILS,
  LABELS,
  NOW,
  openFixtureMailbox,
  TIMEZONE,
} from "@/__tests__/eval/search-retrieval-mailbox";
import {
  RETRIEVAL_QUERIES,
  type RetrievalQuery,
  type RetrievalQueryType,
} from "@/__tests__/eval/search-retrieval.scenarios";
import {
  getWideningLadder,
  getWideningStep,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import { rankWithWidened } from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { conversationSummaryToListThread } from "@/utils/mail-engine/list-thread";
import {
  aiInterpretSearch,
  buildSearchIntentPrompt,
  INTERPRET_SEARCH_TIMEOUT_MS,
  toSearchIntent,
} from "@/utils/ai/mail-search/interpret-search";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import { looksLikeNaturalLanguage } from "@/utils/mail-search/natural-language-search";

// Retrieval quality of Cue's search against Gmail-style keyword search, on a
// synthetic mailbox in the SQLite store the browser runs. No provider: each
// search returns what the local store answers.
//
// pnpm --filter inbox-zero-ai test-ai eval/search-retrieval
// Multi-model: EVAL_MODELS=all pnpm --filter inbox-zero-ai test-ai eval/search-retrieval
// CI: dispatch ai-evals.yml with test_filter=search-retrieval

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 120_000;
const TOP_K = 10;
// More than any query's relevant mail, so widening's additions are seen.
const PAGE_SIZE = 50;
const SEARCH_CONTEXT = {
  labels: LABELS,
  provider: "google" as const,
  timeZone: TIMEZONE,
  now: NOW,
};

const RELEVANCE_CRITERION = {
  name: "The conversation is mail the user is searching for",
  description: `The input is what the user typed into their mailbox search bar, today's date, and a description of the mail they want. The output is one email conversation the search returned.
PASS when someone who typed this search would count this conversation as a correct result: it is the mail they describe, or mail that directly answers what they asked.
FAIL when it only shares a topic or a sender with that mail, falls outside a time the user named, is about a different event or item, or is a newsletter or promotion that merely mentions the same words.`,
};

const BASELINES: {
  system: string;
  search: (query: RetrievalQuery) => string;
}[] = [
  // Gmail matches every word typed, which is also Cue's own plain search.
  { system: "keywords: typed words", search: (query) => query.query },
  { system: "keywords: expert", search: (query) => query.keywords },
];

describe("search-retrieval fixture", () => {
  test("ground truth names messages in the mailbox", () => {
    const ids = FIXTURE_EMAILS.map((email) => email.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missing = RETRIEVAL_QUERIES.flatMap((query) =>
      query.relevant.filter((id) => !ids.includes(id)),
    );
    expect(missing).toEqual([]);
  });
});

describe.runIf(shouldRunEval)("search-retrieval eval", () => {
  const evalReporter = createEvalReporter({ evalName: "search-retrieval" });
  const scores: QueryScore[] = [];
  const judgments = new Map<string, Promise<boolean>>();
  let store: MailStore;
  let closeMailbox: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const mailbox = await openFixtureMailbox();
    store = mailbox.store;
    closeMailbox = mailbox.close;
  });

  afterAll(async () => {
    await closeMailbox?.();
    printRetrievalReport(scores);
    evalReporter.printReport();
  });

  async function score(
    system: string,
    query: RetrievalQuery,
    ranked: string[],
    details: Omit<QueryScore, keyof Metrics | "system" | "query">,
  ) {
    const metrics = await scoreRanking(query, ranked, (conversationId) =>
      judgeRelevant(judgments, query, conversationId),
    );
    const result: QueryScore = { system, query, ...metrics, ...details };
    scores.push(result);
    evalReporter.record({
      testName: `${query.type}: ${query.id}`,
      model: system,
      // Shows the mail first and at least half of it on the first screen.
      pass: metrics.top1 && metrics.recall >= 0.5,
      expected: query.relevant.join(", "),
      actual: JSON.stringify({
        searches: details.searches,
        widened: details.widenedSearches,
        top: ranked.slice(0, 5),
        recall: metrics.recall,
        precision: metrics.precision,
        mrr: metrics.mrr,
      }),
    });
    return result;
  }

  describe("keyword baselines", () => {
    for (const query of RETRIEVAL_QUERIES) {
      test(
        query.id,
        async () => {
          for (const { system, search } of BASELINES) {
            const ranked = await runSearches(store, [search(query)]);
            await score(system, query, ranked, {
              searches: [search(query)],
              widenedSearches: [],
            });
          }
        },
        TIMEOUT,
      );
    }
  });

  describeEvalMatrix("cue search", (model, emailAccount) => {
    for (const query of RETRIEVAL_QUERIES) {
      test(
        query.id,
        async () => {
          // A search that doesn't read as a sentence never takes the AI path.
          const natural = looksLikeNaturalLanguage(query.query);
          const startedAt = Date.now();
          const parts = natural
            ? await aiInterpretSearch({
                emailAccount: { ...emailAccount, timezone: TIMEZONE },
                query: query.query,
                now: NOW,
              })
            : null;
          const latencyMs = Date.now() - startedAt;
          const intent = parts
            ? toSearchIntent(parts, {
                now: NOW,
                timeZone: TIMEZONE,
                provider: "google",
                labelNames: LABELS.map((label) => label.name),
              })
            : null;
          const searches = intent?.searches ?? [];
          const { ranked, widenedSearches, wideningTier, queries } =
            await runCueSearch(store, searches);
          const result = await score(model.label, query, ranked, {
            searches,
            widenedSearches,
            wideningTier,
            queries,
            natural,
            latencyMs,
            isQuestion: intent?.isQuestion,
          });
          console.debug(
            `[${model.label}] ${query.id}: ${JSON.stringify(searches)}${widenedSearches.length ? ` widened ${JSON.stringify(widenedSearches)}` : ""} -> R@10 ${result.recall.toFixed(2)} MRR ${result.mrr.toFixed(2)}`,
          );
          // Retrieval quality is the measurement, not a gate; only a reading
          // that yields no search at all fails here.
          expect(natural ? searches.length : 1).toBeGreaterThan(0);
        },
        TIMEOUT,
      );
    }
  });
});

type Metrics = {
  recall: number;
  precision: number;
  mrr: number;
  top1: boolean;
  /** Conversations in the top results the judge accepted beyond the ground truth. */
  judgedRelevant: string[];
  top: string[];
};

type QueryScore = Metrics & {
  system: string;
  query: RetrievalQuery;
  searches: string[];
  widenedSearches: string[];
  /** The ladder tier that answered, when Cue widened. */
  wideningTier?: string;
  /** Local reads Cue made, the first search's included. */
  queries?: number;
  natural?: boolean;
  latencyMs?: number;
  isQuestion?: boolean;
};

/** Conversation ids matching any of the searches, newest first. */
async function runSearches(store: MailStore, searches: string[]) {
  return (await readSearches(store, searches)).map((thread) => thread.id);
}

/** The list rows for mail matching any of the searches, newest first. */
async function readSearches(store: MailStore, searches: string[]) {
  // As the Cue found section builds its predicate from Cue's searches.
  const predicates = searches.map((q) =>
    threadsQueryToPredicate({ q }, undefined, SEARCH_CONTEXT),
  );
  if (!predicates.length) return [];
  const predicate: MailPredicate =
    predicates.length === 1 ? predicates[0] : { kind: "any", predicates };
  const { view } = await store.readMailboxView({
    accountIds: [ACCOUNT_ID],
    predicate,
    order: "newest_first",
    pageSize: PAGE_SIZE,
    after: null,
  });
  return view.conversations.map((conversation) =>
    conversationSummaryToListThread(conversation),
  );
}

/**
 * Cue's searches, then the widening ladder's tiers when they find too
 * little, up to the first tier that finds more, ranked together as on
 * screen. The provider is stubbed, so its last-resort search finds nothing.
 */
async function runCueSearch(store: MailStore, searches: string[]) {
  const ranking = {
    searches,
    labels: LABELS,
    now: NOW,
    timeZone: TIMEZONE,
    provider: "google" as const,
  };
  const primary = await readSearches(store, searches);
  const primaryIds = new Set(primary.map((thread) => thread.id));
  const ladder = getWideningLadder(searches, ranking);
  let step = getWideningStep({
    step: null,
    primary: { settled: true, count: primary.length },
    widened: { settled: false, count: 0 },
    ladderLength: ladder.length,
    expired: false,
  });
  let wider: ListThread[] = [];
  let queries = 1;
  while (step !== null) {
    queries += 1;
    wider = (await readSearches(store, ladder[step].searches)).filter(
      (thread) => !primaryIds.has(thread.id),
    );
    const next = getWideningStep({
      step,
      primary: { settled: true, count: primary.length },
      widened: { settled: true, count: wider.length },
      ladderLength: ladder.length,
      expired: false,
    });
    if (next === step) break;
    step = next;
  }
  const widening = step === null ? null : ladder[step];
  return {
    ranked: rankWithWidened(primary, wider, ranking).map((thread) => thread.id),
    widenedSearches: widening?.searches ?? [],
    wideningTier: widening?.tier,
    queries,
  };
}

/**
 * Recall against the ground truth alone; precision, MRR and the top result
 * also count conversations the judge accepts, on queries marked fuzzy.
 */
async function scoreRanking(
  query: RetrievalQuery,
  ranked: string[],
  judge: (conversationId: string) => Promise<boolean>,
): Promise<Metrics> {
  const relevant = new Set(
    FIXTURE_EMAILS.filter((email) => query.relevant.includes(email.id)).map(
      conversationOf,
    ),
  );
  const top = ranked.slice(0, TOP_K);
  const judgedRelevant: string[] = [];
  if (query.fuzzy) {
    for (const id of top) {
      if (!relevant.has(id) && (await judge(id))) judgedRelevant.push(id);
    }
  }
  const accepted = (id: string) =>
    relevant.has(id) || judgedRelevant.includes(id);
  const found = top.filter((id) => relevant.has(id)).length;
  const firstHit = top.findIndex(accepted);
  return {
    recall: found / relevant.size,
    precision: top.length ? top.filter(accepted).length / top.length : 0,
    mrr: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    top1: firstHit === 0,
    judgedRelevant,
    top,
  };
}

/** One judgment per query and conversation, shared by every system. */
function judgeRelevant(
  judgments: Map<string, Promise<boolean>>,
  query: RetrievalQuery,
  conversationId: string,
) {
  const key = `${query.id}:${conversationId}`;
  let judgment = judgments.get(key);
  if (!judgment) {
    judgment = judgeEvalOutput({
      criterion: RELEVANCE_CRITERION,
      expected: query.intent,
      input: buildSearchIntentPrompt({
        query: query.query,
        now: NOW,
        timeZone: TIMEZONE,
      }),
      output: formatConversation(conversationId),
    }).then((result) => result.pass);
    judgments.set(key, judgment);
  }
  return judgment;
}

function formatConversation(conversationId: string) {
  return FIXTURE_EMAILS.filter(
    (email) => conversationOf(email) === conversationId,
  )
    .map((email) =>
      [
        `From: ${email.from}`,
        `To: ${(email.to ?? []).join(", ")}`,
        `Date: ${email.at} (${TIMEZONE})`,
        `Subject: ${email.subject}`,
        email.attachments?.length
          ? `Attachments: ${email.attachments.join(", ")}`
          : null,
        "",
        email.body,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    )
    .join("\n\n---\n\n");
}

const QUERY_TYPES: RetrievalQueryType[] = [
  "people",
  "time",
  "attribute",
  "vague",
  "question",
  "multilingual",
];

function printRetrievalReport(scores: QueryScore[]) {
  if (!scores.length) return;
  const systems = [...new Set(scores.map((score) => score.system))];
  const cueSystems = systems.filter(
    (system) => !BASELINES.some((baseline) => baseline.system === system),
  );
  const lines: string[] = [
    "# Search retrieval: Cue vs keyword search",
    "",
    `Mailbox: ${FIXTURE_EMAILS.length} messages. Queries: ${RETRIEVAL_QUERIES.length}. Metrics at ${TOP_K}, over conversations.`,
    "",
    "## By query type",
    "",
    "| System | Type | n | Recall@10 | Precision@10 | MRR | Top-1 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const system of systems) {
    for (const type of [...QUERY_TYPES, "all" as const]) {
      const rows = scores.filter(
        (score) =>
          score.system === system &&
          (type === "all" || score.query.type === type),
      );
      if (!rows.length) continue;
      lines.push(
        `| ${system} | ${type} | ${rows.length} | ${mean(rows, (r) => r.recall)} | ${mean(rows, (r) => r.precision)} | ${mean(rows, (r) => r.mrr)} | ${mean(rows, (r) => (r.top1 ? 1 : 0))} |`,
      );
    }
  }

  for (const cue of cueSystems) {
    const cueRows = scores.filter((score) => score.system === cue);
    lines.push("", `## ${cue}: wins, ties and losses`, "");
    for (const { system } of BASELINES) {
      let wins = 0;
      let ties = 0;
      let losses = 0;
      for (const row of cueRows) {
        const baseline = scores.find(
          (score) => score.system === system && score.query.id === row.query.id,
        );
        if (!baseline) continue;
        const outcome = compare(row, baseline);
        if (outcome > 0) wins += 1;
        else if (outcome < 0) losses += 1;
        else ties += 1;
      }
      lines.push(
        `- vs ${system}: ${wins} wins, ${ties} ties, ${losses} losses (by recall@10, then MRR)`,
      );
    }
    const slow = cueRows.filter(
      (row) => (row.latencyMs ?? 0) > INTERPRET_SEARCH_TIMEOUT_MS,
    );
    const offPath = cueRows.filter((row) => row.natural === false);
    lines.push(
      `- Reading slower than the ${INTERPRET_SEARCH_TIMEOUT_MS} ms production timeout: ${slow.length} (${slow.map((row) => row.query.id).join(", ") || "none"})`,
      `- Not read as a sentence, so no AI path: ${offPath.length} (${offPath.map((row) => row.query.id).join(", ") || "none"})`,
      `- Widened: ${cueRows.filter((row) => row.widenedSearches.length).length} (${wideningSummary(cueRows)})`,
      `- Local reads per search: at most ${Math.max(...cueRows.map((row) => row.queries ?? 1))}`,
    );

    lines.push(
      "",
      `## ${cue}: per query`,
      "",
      "| Query | Type | Typed R/MRR | Expert R/MRR | Cue R/MRR | Cue searches | Widened | Top 3 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const row of cueRows) {
      const [typed, expert] = BASELINES.map(({ system }) =>
        scores.find(
          (score) => score.system === system && score.query.id === row.query.id,
        ),
      );
      lines.push(
        `| ${cell(row.query.query)} | ${row.query.type} | ${pair(typed)} | ${pair(expert)} | ${pair(row)} | ${cell(row.searches.join(" ∥ ") || "(none)")} | ${cell(row.wideningTier ? `${row.wideningTier}: ${row.widenedSearches.join(" ∥ ")}` : "")} | ${cell(row.top.slice(0, 3).join(", "))} |`,
      );
    }
  }

  const report = lines.join("\n");
  console.log(`\n${report}\n`);
  if (process.env.EVAL_REPORT_PATH) {
    const path = join(
      dirname(resolveFromWorkspace(process.env.EVAL_REPORT_PATH)),
      "search-retrieval.md",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${report}\n`);
  }
}

function wideningSummary(rows: QueryScore[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.wideningTier)
      counts.set(row.wideningTier, (counts.get(row.wideningTier) ?? 0) + 1);
  }
  return (
    [...counts].map(([tier, count]) => `${tier} ${count}`).join(", ") || "none"
  );
}

function compare(a: Metrics, b: Metrics) {
  if (a.recall !== b.recall) return a.recall - b.recall;
  return a.mrr - b.mrr;
}

function mean(rows: QueryScore[], value: (row: QueryScore) => number) {
  return (rows.reduce((sum, row) => sum + value(row), 0) / rows.length).toFixed(
    2,
  );
}

function pair(score: Metrics | undefined) {
  return score ? `${score.recall.toFixed(2)}/${score.mrr.toFixed(2)}` : "-";
}

function cell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function resolveFromWorkspace(path: string) {
  if (isAbsolute(path)) return path;
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return join(process.cwd(), path);
    dir = parent;
  }
  return join(dir, path);
}
